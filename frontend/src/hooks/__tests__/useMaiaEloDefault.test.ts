// @vitest-environment jsdom
/**
 * useMaiaEloDefault unit tests (151-06-PLAN.md Task 1).
 *
 * Behaviors verified:
 * 1. Game mode, white user, white_rating=1720 -> resolved default 1720 (clamped to ladder bounds).
 * 2. Game mode, black user -> resolves from black_rating.
 * 3. Free play, profile.current_strength.rating=1650 -> resolved default 1650.
 * 4. Free play, current_strength null -> FREE_PLAY_DEFAULT_ELO (1500).
 * 5. User-override precedence: a later gameData/profile load does not clobber a user pick.
 * 6. Re-derivation happens when gameData/profile FIRST load (not on every re-render).
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useMaiaEloDefault,
  FREE_PLAY_DEFAULT_ELO,
  deriveRawDefault,
  clampToLadderBounds,
} from '../useMaiaEloDefault';
import type { MaiaEloGameData, MaiaEloProfile } from '../useMaiaEloDefault';
import { MAIA_ELO_LADDER } from '@/lib/maiaEncoding';

function gameData(overrides: Partial<MaiaEloGameData>): MaiaEloGameData {
  return {
    user_color: 'white',
    white_rating: null,
    black_rating: null,
    white_rating_lichess_blitz: undefined,
    black_rating_lichess_blitz: undefined,
    ...overrides,
  };
}

/**
 * WR-04: `current_strength.rating` is the ONLY rating `MaiaEloProfile` exposes, so
 * the free-play repoint is enforced by the TYPE rather than by an assertion — the
 * hook cannot see a raw platform rating even if `UserProfile` grows one again. (It
 * carried a `current_rating` field until SEED-147 deleted it, then a plain
 * `lichess_blitz_equivalent_rating` field until this same quick task replaced it
 * with `current_strength`. If a raw rating field is reintroduced, widen this
 * factory rather than adding it to `MaiaEloProfile`.)
 */
function profile(currentStrengthRating: number | null): MaiaEloProfile {
  return { current_strength: currentStrengthRating === null ? null : { rating: currentStrengthRating } };
}

describe('useMaiaEloDefault', () => {
  it('game mode, white user: resolves from white_rating, clamped to ladder bounds (not step-snapped)', () => {
    const { result } = renderHook(() =>
      useMaiaEloDefault({
        isGameMode: true,
        gameData: gameData({ user_color: 'white', white_rating: 1720, black_rating: 1600 }),
        profile: undefined,
      }),
    );
    expect(result.current.selectedElo).toBe(1720);
  });

  it('game mode, black user: resolves from black_rating', () => {
    const { result } = renderHook(() =>
      useMaiaEloDefault({
        isGameMode: true,
        gameData: gameData({ user_color: 'black', white_rating: 1720, black_rating: 1350 }),
        profile: undefined,
      }),
    );
    expect(result.current.selectedElo).toBe(1350);
  });

  it('game mode: defaults to the SIDE-TO-MOVE rating (opponent on their move), not always the user', () => {
    const { result } = renderHook(() =>
      useMaiaEloDefault({
        isGameMode: true,
        gameData: gameData({ user_color: 'white', white_rating: 1720, black_rating: 1350 }),
        profile: undefined,
        // White user, but it's Black (the opponent) to move → default to Black's rating.
        sideToMove: 'black',
      }),
    );
    expect(result.current.selectedElo).toBe(1350);
  });

  it('game mode: sideToMove on the user\'s own move resolves from the user\'s rating', () => {
    const { result } = renderHook(() =>
      useMaiaEloDefault({
        isGameMode: true,
        gameData: gameData({ user_color: 'white', white_rating: 1720, black_rating: 1350 }),
        profile: undefined,
        sideToMove: 'white',
      }),
    );
    expect(result.current.selectedElo).toBe(1720);
  });

  it('game mode: normalized field present for the mover color is used instead of the raw rating', () => {
    const { result } = renderHook(() =>
      useMaiaEloDefault({
        isGameMode: true,
        gameData: gameData({
          user_color: 'white',
          white_rating: 1720,
          black_rating: 1350,
          white_rating_lichess_blitz: 1780,
        }),
        profile: undefined,
        sideToMove: 'white',
      }),
    );
    expect(result.current.selectedElo).toBe(1780);
  });

  it('game mode: normalized field null/absent for the mover color falls back to the raw rating', () => {
    const { result } = renderHook(() =>
      useMaiaEloDefault({
        isGameMode: true,
        gameData: gameData({
          user_color: 'white',
          white_rating: 1720,
          black_rating: 1350,
          white_rating_lichess_blitz: null,
        }),
        profile: undefined,
        sideToMove: 'white',
      }),
    );
    expect(result.current.selectedElo).toBe(1720);
  });

  it('game mode: mixed — normalized present for one color, null for the other — picks per-color by sideToMove', () => {
    const mixedGameData = gameData({
      user_color: 'white',
      white_rating: 1720,
      black_rating: 1350,
      white_rating_lichess_blitz: 1780,
      black_rating_lichess_blitz: null,
    });

    const white = renderHook(() =>
      useMaiaEloDefault({
        isGameMode: true,
        gameData: mixedGameData,
        profile: undefined,
        sideToMove: 'white',
      }),
    );
    expect(white.result.current.selectedElo).toBe(1780);

    const black = renderHook(() =>
      useMaiaEloDefault({
        isGameMode: true,
        gameData: mixedGameData,
        profile: undefined,
        sideToMove: 'black',
      }),
    );
    expect(black.result.current.selectedElo).toBe(1350);
  });

  it('free play: resolves from profile.current_strength.rating', () => {
    // The normalized blitz anchor is the only rating the hook may read; a raw
    // platform rating would be chess.com-inflated relative to the Maia scale.
    const { result } = renderHook(() =>
      useMaiaEloDefault({
        isGameMode: false,
        gameData: undefined,
        profile: profile(1650),
      }),
    );
    expect(result.current.selectedElo).toBe(1650);
  });

  it('free play: current_strength null falls back to FREE_PLAY_DEFAULT_ELO', () => {
    const { result } = renderHook(() =>
      useMaiaEloDefault({
        isGameMode: false,
        gameData: undefined,
        // No blitz anchor -> the free-play default must fall back to 1500 rather
        // than reaching for any other rating on the profile.
        profile: profile(null),
      }),
    );
    expect(result.current.selectedElo).toBe(FREE_PLAY_DEFAULT_ELO);
    expect(FREE_PLAY_DEFAULT_ELO).toBe(1500);
  });

  it('free play: profile undefined falls back to FREE_PLAY_DEFAULT_ELO', () => {
    const { result } = renderHook(() =>
      useMaiaEloDefault({
        isGameMode: false,
        gameData: undefined,
        profile: undefined,
      }),
    );
    expect(result.current.selectedElo).toBe(FREE_PLAY_DEFAULT_ELO);
  });

  it('free play: a raw current_strength.rating outside the ladder still clamps to ladder bounds', () => {
    const { result } = renderHook(() =>
      useMaiaEloDefault({
        isGameMode: false,
        gameData: undefined,
        profile: profile(2900),
      }),
    );
    expect(result.current.selectedElo).toBe(MAIA_ELO_LADDER[MAIA_ELO_LADDER.length - 1]);
  });

  it('user-override precedence: a user pick wins over a LATER gameData load', () => {
    const { result, rerender } = renderHook(
      (props: { gd: MaiaEloGameData | undefined }) =>
        useMaiaEloDefault({ isGameMode: true, gameData: props.gd, profile: undefined }),
      { initialProps: { gd: undefined } },
    );

    // Data hasn't loaded yet — falls back to the free-play default as a placeholder.
    expect(result.current.selectedElo).toBe(FREE_PLAY_DEFAULT_ELO);

    // User picks a value before gameData arrives.
    act(() => result.current.setSelectedElo(1900));
    expect(result.current.selectedElo).toBe(1900);

    // gameData arrives late — must NOT clobber the user's pick.
    rerender({ gd: gameData({ user_color: 'white', white_rating: 1720, black_rating: 1600 }) });
    expect(result.current.selectedElo).toBe(1900);
  });

  it('exposes defaultElo as the clamped players default', () => {
    const { result } = renderHook(() =>
      useMaiaEloDefault({
        isGameMode: true,
        gameData: gameData({ user_color: 'white', white_rating: 1720, black_rating: 1600 }),
        profile: undefined,
        sideToMove: 'white',
      }),
    );
    expect(result.current.defaultElo).toBe(1720);
  });

  it('resetToDefault snaps back to the default and re-arms re-derivation (164 UAT)', () => {
    const { result, rerender } = renderHook(
      (props: { gd: MaiaEloGameData | undefined }) =>
        useMaiaEloDefault({
          isGameMode: true,
          gameData: props.gd,
          profile: undefined,
          sideToMove: 'white',
        }),
      { initialProps: { gd: gameData({ user_color: 'white', white_rating: 1720, black_rating: 1600 }) } },
    );
    expect(result.current.selectedElo).toBe(1720);

    // User drags off the default, then resets.
    act(() => result.current.setSelectedElo(2100));
    expect(result.current.selectedElo).toBe(2100);
    act(() => result.current.resetToDefault());
    expect(result.current.selectedElo).toBe(1720);

    // Re-derivation is re-armed: a later rating change now tracks again (the override
    // flag was cleared by the reset), rather than staying pinned to the old pick.
    rerender({ gd: gameData({ user_color: 'white', white_rating: 1450, black_rating: 1600 }) });
    expect(result.current.selectedElo).toBe(1450);
  });

  it('re-derives once when gameData/profile first load, before any user pick', () => {
    const { result, rerender } = renderHook(
      (props: { gd: MaiaEloGameData | undefined }) =>
        useMaiaEloDefault({ isGameMode: true, gameData: props.gd, profile: undefined }),
      { initialProps: { gd: undefined } },
    );

    expect(result.current.selectedElo).toBe(FREE_PLAY_DEFAULT_ELO);

    // Data arrives — no user pick yet, so the default IS re-derived.
    rerender({ gd: gameData({ user_color: 'white', white_rating: 1720, black_rating: 1600 }) });
    expect(result.current.selectedElo).toBe(1720);

    // A subsequent re-render with the SAME resolved rating is a no-op (still 1720),
    // proving the effect keys off the derived value, not "every render".
    rerender({ gd: gameData({ user_color: 'white', white_rating: 1720, black_rating: 1600 }) });
    expect(result.current.selectedElo).toBe(1720);
  });
});

/**
 * Direct-call tests for the exported pure helpers (Phase 172, SEED-106 D-01).
 * These are called directly (not through the hook) because the gem sweep
 * consumes them the same way: pinned to a fixed mover, structurally
 * independent of any slider/selectedElo state.
 */
describe('deriveRawDefault / clampToLadderBounds (D-01 direct-call exports)', () => {
  it('D-01: deriveRawDefault(white) returns white_rating_lichess_blitz, falling back to white_rating when null', () => {
    const withNormalized = gameData({
      user_color: 'white',
      white_rating: 1720,
      black_rating: 1350,
      white_rating_lichess_blitz: 1780,
    });
    expect(deriveRawDefault(true, withNormalized, undefined, 'white')).toBe(1780);

    const withoutNormalized = gameData({
      user_color: 'white',
      white_rating: 1720,
      black_rating: 1350,
      white_rating_lichess_blitz: null,
    });
    expect(deriveRawDefault(true, withoutNormalized, undefined, 'white')).toBe(1720);
  });

  it('D-01: the SAME gameData yields DIFFERENT rungs for white vs black — a gem is a property of the game, not of the view', () => {
    const shared = gameData({
      user_color: 'white',
      white_rating: 1720,
      black_rating: 1350,
      white_rating_lichess_blitz: 1780,
      black_rating_lichess_blitz: 1400,
    });
    const whiteRung = deriveRawDefault(true, shared, undefined, 'white');
    const blackRung = deriveRawDefault(true, shared, undefined, 'black');
    expect(whiteRung).toBe(1780);
    expect(blackRung).toBe(1400);
    expect(whiteRung).not.toBe(blackRung);
  });

  it('deriveRawDefault(true, undefined, ...) returns null — game data not loaded yet', () => {
    expect(deriveRawDefault(true, undefined, undefined, 'white')).toBeNull();
  });

  it('clampToLadderBounds clamps to the ladder outer bounds without step-snapping', () => {
    const min = MAIA_ELO_LADDER[0] as number;
    const max = MAIA_ELO_LADDER[MAIA_ELO_LADDER.length - 1] as number;
    expect(clampToLadderBounds(1720)).toBe(1720); // not step-snapped
    expect(clampToLadderBounds(min - 500)).toBe(min);
    expect(clampToLadderBounds(max + 500)).toBe(max);
  });

  it('D-01 regression: setSelectedElo does NOT perturb deriveRawDefault for a fixed mover — the pinned rung is structurally independent of the slider', () => {
    const gd = gameData({
      user_color: 'white',
      white_rating: 1720,
      black_rating: 1350,
      white_rating_lichess_blitz: 1780,
    });

    const { result } = renderHook(() =>
      useMaiaEloDefault({ isGameMode: true, gameData: gd, profile: undefined, sideToMove: 'white' }),
    );

    // Baseline: the pinned rung for white, computed directly.
    expect(deriveRawDefault(true, gd, undefined, 'white')).toBe(1780);

    // Drag the slider to an arbitrary far-off value.
    act(() => result.current.setSelectedElo(2600));
    expect(result.current.selectedElo).toBe(2600);

    // deriveRawDefault reads only (isGameMode, gameData, profile, sideToMove) —
    // it never touches selectedElo — so calling it again for the SAME mover
    // returns the SAME value, unperturbed by the slider move.
    expect(deriveRawDefault(true, gd, undefined, 'white')).toBe(1780);
  });
});
