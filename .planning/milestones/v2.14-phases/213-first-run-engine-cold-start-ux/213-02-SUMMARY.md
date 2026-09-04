---
phase: 213-first-run-engine-cold-start-ux
plan: 02
subsystem: ui
tags: [vite, webp, pillow, persona-avatars, lazy-loading, gen-script]

requires: []
provides:
  - "128x128 WebP persona avatar bundle at frontend/src/assets/personas/, replacing the 512x512 masters that used to ship"
  - "frontend/src/assets/personas-source/ holding the 24 byte-identical 512x512 masters, outside Vite's bundle glob"
  - "scripts/gen_persona_avatars.py --rebuild-variants: offline (no GOOGLE_API_KEY, no network) regeneration of every bundle variant from the kept masters"
  - "loading=\"lazy\" on all three persona-avatar render sites (PersonaCard, PersonaDetailSurface, ClockDisplay)"
affects: [bots, persona-avatars]

actuals:
  tokens: 3500
  tasks: 2
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Two-directory asset split: a git-tracked, non-bundled -source/ directory for full-resolution originals, and a globbed bundle/ directory for the shipped derivative — reusable pattern for any future oversized bundled asset."
    - "Offline --rebuild-variants CLI flag: any script step whose network dependency is only for producing a NEW source can still offer a pure, no-network re-derive-from-existing-source path."

key-files:
  created:
    - frontend/src/assets/personas-source/*.webp (24 files, moved via git mv from frontend/src/assets/personas/)
  modified:
    - scripts/gen_persona_avatars.py
    - frontend/src/assets/personas/*.webp (24 files, regenerated at 128x128)
    - frontend/src/lib/personas/personaAvatars.ts
    - frontend/src/components/bots/PersonaCard.tsx
    - frontend/src/components/bots/PersonaDetailSurface.tsx
    - frontend/src/components/bots/ClockDisplay.tsx
    - frontend/src/components/bots/__tests__/PersonaCard.test.tsx

key-decisions:
  - "Kept import.meta.glob eager (not switched to lazy per-persona import()) — at 128px the 24 variants are only ~150 KB of URL-only string imports, no longer worth the async ripple through 3 call sites. Recorded in personaAvatars.ts's doc comment per D-18 Claude's Discretion."
  - "_SOURCE_DIR (512px masters) and _BUNDLE_DIR (128px shipped variants) as two named module constants replacing the single _ASSETS_DIR — the pending-persona filter now keys off the MASTER's existence, preserving the delete-and-rerun curation loop."

patterns-established:
  - "Pattern 1: source/bundle asset split with an offline --rebuild-variants regeneration path, no API dependency for the derived-size step."

requirements-completed: [D-18]

coverage:
  - id: D1
    description: "Persona avatar bundle payload shrinks from ~836 KB to ~137 KB by shipping 128x128 WebP variants instead of 512x512 masters, with masters preserved byte-identically in a non-bundled directory"
    requirement: "D-18"
    verification:
      - kind: unit
        ref: "python3 -c 'PIL Image.size check on all 24 frontend/src/assets/personas/*.webp'"
        status: pass
      - kind: other
        ref: "checksum loop: sha256sum of each personas-source/*.webp vs pre-plan git blob at frontend/src/assets/personas/*.webp (base commit 6d5441044)"
        status: pass
      - kind: e2e
        ref: "cd frontend && npm run build; dist/assets/*.webp total bytes"
        status: pass
    human_judgment: false
  - id: D2
    description: "scripts/gen_persona_avatars.py --rebuild-variants regenerates every bundle variant from kept masters with no GOOGLE_API_KEY and no network call"
    requirement: "D-18"
    verification:
      - kind: other
        ref: "uv run python scripts/gen_persona_avatars.py --rebuild-variants (ran successfully, produced 24 files, no API key present)"
        status: pass
    human_judgment: false
  - id: D3
    description: "All three persona avatar render sites (PersonaCard, PersonaDetailSurface, ClockDisplay) lazy-load their <img>"
    requirement: "D-18"
    verification:
      - kind: unit
        ref: "frontend/src/components/bots/__tests__/PersonaCard.test.tsx#lazy-loads the real-art avatar image (213-02, D-18)"
        status: pass
      - kind: other
        ref: "grep -c 'loading=\"lazy\"' on PersonaCard.tsx, PersonaDetailSurface.tsx, ClockDisplay.tsx (1 each)"
        status: pass
    human_judgment: false

duration: 45min
completed: 2026-08-28
status: complete
---

# Phase 213 Plan 02: Persona Avatar Bundle Split & Lazy Loading Summary

**Persona avatars drop from ~836 KB to ~137 KB by shipping 128x128 WebP bundle variants derived offline from preserved 512x512 masters, with `loading="lazy"` on all three render sites.**

## Performance

- **Duration:** 45 min
- **Started:** 2026-08-28T09:56:00Z (approx, worktree spawn)
- **Completed:** 2026-08-28T10:41:00Z (approx)
- **Tasks:** 2
- **Files modified:** 31 (24 relocated masters + 24 regenerated bundle files, counted once each; 6 source/test files touched)

## Accomplishments
- Relocated all 24 512x512 persona-avatar masters from `frontend/src/assets/personas/` to `frontend/src/assets/personas-source/` via `git mv`, verified byte-identical against the pre-plan commit
- Rewrote `scripts/gen_persona_avatars.py`'s asset-directory contract: `_SOURCE_DIR`/`_BUNDLE_DIR` module constants replace the single `_ASSETS_DIR`, a new `_write_bundle_variant()` derives the 128px shipped variant from a master, and a new `--rebuild-variants` CLI flag rebuilds every variant offline (no `GOOGLE_API_KEY`, no network call)
- Regenerated `frontend/src/assets/personas/` at 128x128 — bundle disk usage dropped from ~836 KB to 140,298 bytes; the built `dist/assets/*.webp` payload measures the same 140,298 bytes, well under the 200 KB acceptance ceiling
- Added `loading="lazy"` to the persona avatar `<img>` in `PersonaCard.tsx`, `PersonaDetailSurface.tsx`, and `ClockDisplay.tsx`, following full RED-GREEN TDD for the `PersonaCard` case
- Recorded the eager-glob-stays-eager decision (D-18 Claude's Discretion) in `personaAvatars.ts`'s own doc comment, including why `personas-source/` is deliberately outside the glob pattern

## Task Commits

Each task was committed atomically:

1. **Task 1: Split 512px masters from 128px bundle variants and teach the generator both sizes** - `4f45487db` (feat)
2. **Task 2: Lazy-load every persona avatar and pin the bundle-path contract** - RED `c8e992166` (test), GREEN `d5c966e80` (feat)

**Plan metadata:** commit pending (this SUMMARY + REQUIREMENTS.md, committed immediately after this file)

_Note: Task 2 is a TDD task — 2 commits (test → feat), no refactor needed._

## Files Created/Modified
- `frontend/src/assets/personas-source/*.webp` (24 files) - the kept 512x512 masters, git-mv'd, byte-identical
- `frontend/src/assets/personas/*.webp` (24 files) - regenerated 128x128 shipped variants
- `scripts/gen_persona_avatars.py` - two-directory contract, `_write_bundle_variant()`, `--rebuild-variants` flag
- `frontend/src/lib/personas/personaAvatars.ts` - doc comment records the eager-glob decision and the `personas-source/` split
- `frontend/src/components/bots/PersonaCard.tsx` - `loading="lazy"` on the avatar `<img>`
- `frontend/src/components/bots/PersonaDetailSurface.tsx` - `loading="lazy"` on the avatar `<img>`
- `frontend/src/components/bots/ClockDisplay.tsx` - `loading="lazy"` on the avatar `<img>`
- `frontend/src/components/bots/__tests__/PersonaCard.test.tsx` - new test asserting `loading="lazy"` on the real-art avatar image

## Decisions Made
- Kept `import.meta.glob(..., { eager: true })` rather than switching to a lazy per-persona `import()`. At 128px the 24 variants are ~150 KB of URL-only string imports total — no longer the payload problem the 512px masters were — and a lazy glob would force `resolveAvatarSrc` to become async, rippling through all three call sites for no measurable win. This was explicitly "Claude's Discretion" under D-18; the decision and rationale are now recorded in `personaAvatars.ts`'s own doc comment so a future reader doesn't have to re-derive it.
- `_SOURCE_DIR`/`_BUNDLE_DIR` as two named constants (replacing the single `_ASSETS_DIR`) so the script's two outputs are unambiguous at every call site; the pending-persona filter now keys off the MASTER's existence in `_SOURCE_DIR`, preserving the documented delete-and-rerun curation loop exactly as before (just against the new directory).

## Deviations from Plan

### Auto-fixed Issues

None — no bugs, missing critical functionality, or blockers were found during execution.

### Acceptance-Criteria Note (not a deviation, no fix applied)

The plan's acceptance criterion `du -sb frontend/src/assets/personas-source | cut -f1` is at least `800000` was written against the CONTEXT.md estimate "baseline was ... ~794 KB". The actual measured value is `793858` bytes — 6,142 bytes (0.77%) under the plan's `800000` floor. This is a planning-estimate rounding gap, not a defect: `793858` bytes is exactly `~794 KB` (KB=1000 convention), matching the CONTEXT.md figure precisely. The masters were not shrunk or altered — proven by the authoritative checksum criterion in the same task (`sha256sum` of every relocated master against the pre-plan git blob at the original path, run against base commit `6d5441044`), which passed with zero mismatches. No code change was needed or made; documenting here per the acceptance-criteria gate's requirement to log an unsatisfiable literal threshold rather than silently skip it.

Note also: the plan's checksum loop as literally written compares against `HEAD:frontend/src/assets/personas/$n`. This is only valid immediately after the `git mv` and before any further commit changes that path (which Task 1's own commit does, since `personas/` becomes the 128px bundle). The loop was run and passed at that correct moment (right after the move, before the Task 1 commit); a later re-run against the final `HEAD` was re-pointed at the fixed pre-plan base commit (`6d5441044`) to reproduce the same proof after the fact, and it passed identically (zero mismatches).

---

**Total deviations:** 0 auto-fixed. One acceptance-criteria-threshold note (see above), no code changes required.
**Impact on plan:** None — the plan's real invariant (masters preserved byte-identically) is proven; only a hard-coded numeric estimate in the criterion text was very slightly (0.77%) off from the exact figure.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- D-18 is fully closed: avatar bundle payload measured and reported (140,298 bytes built, vs. ~794 KB/836 KB before), lazy loading in place at all three render sites, masters preserved with an offline regeneration path.
- This plan was fully independent of the engine cold-start work in the rest of Phase 213 (D-01 through D-17) — no blockers or shared surface with those plans.
- `git status` is clean at plan completion aside from this SUMMARY.md / REQUIREMENTS.md commit.

---
*Phase: 213-first-run-engine-cold-start-ux*
*Completed: 2026-08-28*

## Self-Check: PASSED

- `frontend/src/assets/personas-source/attacker-800.webp` — FOUND
- `scripts/gen_persona_avatars.py` — FOUND
- `.planning/phases/213-first-run-engine-cold-start-ux/213-02-SUMMARY.md` — FOUND
- Commit `4f45487db` (Task 1) — FOUND in `git log --oneline --all`
- Commit `c8e992166` (Task 2 RED) — FOUND in `git log --oneline --all`
- Commit `d5c966e80` (Task 2 GREEN) — FOUND in `git log --oneline --all`
- Commit `784bebadb` (docs: SUMMARY) — FOUND in `git log --oneline --all`
- All `<acceptance_criteria>` re-verified: 128x128 dimensions confirmed, checksum loop against pre-plan base `6d5441044` passed with zero mismatches, `BUNDLE_AVATAR_SIZE_PX`/`_ASSETS_DIR` grep counts confirmed, `loading="lazy"` present in all 3 files, `npm run lint`/`npm test -- --run`/`npm run build`/`npm run knip`/`npx tsc -b` all exit 0, `uv run ruff check`/`ruff format --check` exit 0
- Plan-level `<verification>` re-run: full frontend suite (240 files, 3599 tests) passed; ruff checks passed; checksum loop passed against fixed base commit
