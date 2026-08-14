---
quick_id: 260813-o4s
date: 2026-08-13
status: complete
commits:
  - f9f5fc90f feat(quick-260813-o4s): swap Move/Capture clips for tighter one-shots
  - e31190d93 docs(quick-260813-o4s): correct README sound attribution after clip swap
---

# Quick 260813-o4s Summary

Replaced the two most-heard bot-play clips and corrected the README's now-false
blanket licensing claim.

## What changed

**`frontend/public/sound/Move.mp3`, `Capture.mp3`** — replaced with one-shots cut
from sounddino.com chess field recordings (user's choice after auditioning eight
candidates across four sources).

| clip | before (lila `sfx`) | after | reference (`standard`) |
|------|--------------------|-------|------------------------|
| Move | 96.7 ms / 2764 Hz | 64.8 ms / 1263 Hz | 40.2 ms / 889 Hz |
| Capture | 330.7 ms / 5053 Hz | 67.0 ms / 1717 Hz | 62.9 ms / 1344 Hz |

Metrics are effective duration (first/last sample above −40 dB of peak) and
spectral centroid. The old Capture clip ringing 5× longer and 3× brighter than
lichess's was the main complaint.

**`README.md`** — "## Sound Assets" rewritten from one blanket "all Enigmahack
AGPLv3+" claim into the three provenances that actually exist.

## Why the clips were re-cut rather than used as downloaded

The sounddino downloads are field recordings (0.5 s–27.8 s, containing 1–17
separate hits), not game-ready one-shots. Each was onset-detected, the strongest
well-isolated transient cut with a 90 ms window, faded and normalized. Script:
session scratchpad `extract_knock.py` (not committed — throwaway tooling).

## Licensing decision

sounddino.com has no license or terms page (`/en/node/license/` and
`/en/node/terms/` both 404; footer has only Privacy and DMCA). Its only usage
statement is the category-page claim of royalty-free, no-attribution, commercial
use. Its DMCA page refers to contacting "the affected user", implying hosted
third-party uploads.

The user made an explicit risk-based call to accept this: low likelihood of a
claim over a sub-100 ms click, trivial remedy. The README records the source URLs
and retrieval date so the swap stays mechanical, and deliberately asserts no
license for those two files. Rejected alternatives: lichess `standard` (listed
under **Exceptions (non-free)** in lila's `COPYING.md`), and synthesized CC0
candidates (centroids 300+ Hz too dark against the reference).

## Verification

- `ffprobe` confirms new durations; MD5s confirm the two clips are distinct audio
  (identical 1925-byte size is just constant 96 kbps at the same window length).
- `vitest run src/lib/__tests__/sounds.test.ts` — 13 passed. Filenames unchanged,
  so `sounds.ts` `SOUND_FILES` and the test needed no edit.
- `frontend/dist/` is gitignored; only the two `public/sound/` files are tracked.

## Left open

- **`Checkmate.mp3` is byte-identical to `Check.mp3`** (faithful to lila, whose
  `sfx/Checkmate.mp3` is a symlink). Checkmate sounds exactly like a check.
  Choosing a distinct clip needs the user's ear, so it was documented in the
  README rather than guessed at here.
- **No CHANGELOG entry.** The swap is user-facing in the sense that players will
  hear it, but it changes no behavior. Add an `### Changed` bullet under
  `[Unreleased]` if it should appear in the release notes.
