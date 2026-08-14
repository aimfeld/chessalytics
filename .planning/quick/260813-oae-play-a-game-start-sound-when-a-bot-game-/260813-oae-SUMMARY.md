---
quick_id: 260813-oae
date: 2026-08-13
status: complete
commits:
  - 3a0d5f92a feat(quick-260813-oae): re-pick Move/Capture from the horse-walks take
  - 6b2272bfe feat(quick-260813-oae): play a start sound when a bot game begins
---

# Quick 260813-oae Summary

## What changed

**Move/Capture re-picked.** Every individual hit was split out of both multi-hit
sounddino recordings for audition. Final picks, both from the horse-walks take
and both bleed-free (nearest neighbouring onset 700ms/1560ms away, well clear of
the 90ms cut window):

| clip | hit | at | duration | centroid |
|------|-----|-----|----------|----------|
| Move | 6 of 6 | 5.16s | 67.0 ms | 1717 Hz |
| Capture | 2 of 6 | 0.77s | 72.7 ms | 1931 Hz |

`sd_moving_series.mp3` was also split (36 hits) but contributed nothing: only 8
were bleed-free, and all 36 ran 3731-8061 Hz against an 889/1344 Hz reference.

**Game-start sound.** New `game-start` SoundEvent -> `GameStart.mp3`, the uncut
~0.78s `there-is-such-an-option-small-figures.mp3`. Fired from
`BotsPage.handleStart` (`frontend/src/pages/Bots.tsx`), the single start path
shared by SetupScreen's Start, PersonaDetailSurface's Play, and Rematch.

## Two decisions worth keeping

**Why `handleStart` and not a mount effect.** `handleStart` runs inside the
click gesture, which is what satisfies the iOS/mobile-Chrome autoplay policy
(Pitfall 4). A `BotsGame` mount effect would fire outside any gesture and depend
on `unlockAudio` having already run.

**Why the unlock guard tests `=== false`.** `unlockAudio` play/pauses every
clip. Since `game-start` is ~0.78s, the first pointerdown inside the game view
can land while it is still sounding and cut it off, so `unlockAudio` now skips
already-playing clips. The obvious spelling, `if (!audio.paused) continue`, is a
trap: the test `MockAudio` has no `paused` property, so `!undefined` is `true`
and every clip would be skipped, silently turning `unlockAudio` into a no-op and
breaking audio on iOS. Testing `audio.paused === false` fails toward unlocking.

## Verification

- Guard mutation-tested in both directions. Removing it entirely fails only
  "unlockAudio does not interrupt a clip that is already playing"; weakening it
  to `!audio.paused` fails only "unlockAudio still unlocks when `paused` is
  undefined". One test each, so neither is redundant.
- One test was initially bogus and got fixed: it did
  `delete MockAudio.prototype.paused`, but `paused = true` is an instance field,
  so the prototype delete was a no-op and the test passed for the wrong reason.
  Replaced with a `stubAudioWithoutPaused()` helper that deletes the own
  property per instance, re-stubbed after `loadSounds()` but before
  `unlockAudio()` (sounds.ts constructs its Audio instances lazily).
- Full frontend gate green: build (tsc), eslint, knip, 3471 tests / 233 files.

## Notes

- The `Not implemented: HTMLMediaElement's play()` warnings in the test log are
  pre-existing, not introduced here: `Bots.tsx` already called `unlockAudio()`
  at HEAD and `Bots.test.tsx` does not mock `@/lib/sounds`. Mocking it there
  would quieten the log but was out of scope.
- `Checkmate.mp3` is still byte-identical to `Check.mp3` (carried over from
  260813-o4s) — checkmate sounds exactly like a check.
- No CHANGELOG entry, consistent with 260813-o4s. A game-start sound is
  arguably user-facing enough to warrant one.
