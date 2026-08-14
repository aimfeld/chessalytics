---
quick_id: 260813-oae
date: 2026-08-13
status: complete
---

# Quick 260813-oae: Game-start sound + re-picked Move/Capture clips

Two related sound changes, executed as separate atomic commits.

## Task 1: Re-pick Move/Capture from the horse-walks take

Quick 260813-o4s installed Move from the one-piece-move recording and Capture
from hit 6 of the horse-walks take. After splitting every individual hit out of
both multi-hit recordings for audition, the user re-picked both from the
horse-walks take.

Splitting used a lower onset threshold (12% of peak, vs 35%) to catch quiet
hits. `sd_moving_series.mp3` yielded 36 hits but only 8 were bleed-free — the
take is dense enough that a 90ms cut window overlaps the next attack — and all
36 ran 3731-8061 Hz against an 889/1344 Hz reference, so none were used.

Final: Move = hit 6 (5.16s), Capture = hit 2 (0.77s). Both bleed-free.

## Task 2: Game-start sound

Add a `game-start` SoundEvent playing `GameStart.mp3` (the uncut ~0.78s
`there-is-such-an-option-small-figures.mp3`) when a bot game begins.

- **Where:** `BotsPage.handleStart` in `frontend/src/pages/Bots.tsx` — the
  single start path (T-183-11), shared by SetupScreen's Start,
  PersonaDetailSurface's Play, and Rematch. Chosen over a `BotsGame` mount
  effect because it runs inside the click gesture, satisfying the iOS autoplay
  policy (Pitfall 4) without depending on `unlockAudio` having run.
- **Hazard introduced:** `unlockAudio` play/pauses every clip. Because
  `game-start` is ~0.78s, the first pointerdown inside the game view
  (`bots-page`'s `onPointerDown={handleFirstInteraction}`) can land while it is
  still sounding and cut it off. `unlockAudio` now skips already-playing clips.
- **Guard direction:** test `audio.paused === false`, not `!audio.paused`. The
  test `MockAudio` has no `paused` property, so the naive form would evaluate
  `!undefined` -> true and silently skip every clip, making unlockAudio a no-op.
  Failing to unlock is far worse than clipping one sound.

## Verification

- Both halves of the guard mutation-tested: removing it fails the
  "does not interrupt" test; weakening it to `!audio.paused` fails the
  "paused is undefined" test. One test each, no overlap.
- Full frontend gate: build (tsc), eslint, knip, 3471 tests across 233 files.
