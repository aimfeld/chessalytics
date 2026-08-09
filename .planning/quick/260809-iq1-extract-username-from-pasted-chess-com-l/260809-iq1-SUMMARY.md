---
phase: 260809-iq1
plan: 01
subsystem: import
tags: [react, typescript, pydantic, regex, fastapi]

requires: []
provides:
  - Shared frontend TS util `extractPlatformUsername` recognizing chess.com/lichess profile URLs
  - Import page paste/blur normalization on both username fields
  - Matching backend Pydantic validators on ImportRequest and UserProfileUpdate
affects: [import, users]

actuals:
  tokens: 5600
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Paired frontend/backend regex normalizers kept structurally identical (named constants, same case table) so one implementation can be reviewed against the other"

key-files:
  created:
    - frontend/src/lib/platformUsername.ts
    - frontend/src/lib/__tests__/platformUsername.test.ts
    - app/core/platform_usernames.py
    - tests/schemas/test_platform_username.py
  modified:
    - frontend/src/pages/Import.tsx
    - frontend/src/pages/__tests__/Import.stateMachine.test.tsx
    - app/schemas/imports.py
    - app/schemas/users.py

key-decisions:
  - "D-01: unrecognized input (including a cross-platform URL) passes through trimmed, unchanged — no error state"
  - "D-02: normalization applied on paste, blur, AND handleSync's submit path (Enter fires before blur)"
  - "D-03: ImportRequest.username validator runs mode=\"before\" so it precedes max_length=100; UserProfileUpdate uses two per-field validators each pinned to its own platform"

patterns-established:
  - "Pure-logic core module under app/core/ mirroring a frontend lib util case-for-case (see app/core/opponent_strength.py precedent)"

requirements-completed: [QUICK-IQ1]

coverage:
  - id: D1
    description: "extractPlatformUsername (frontend) extracts the bare username from chess.com/lichess profile URLs, with/without scheme, www, trailing slash, query string, extra path segments; passes through unrecognized/cross-platform input trimmed"
    requirement: "QUICK-IQ1"
    verification:
      - kind: unit
        ref: "frontend/src/lib/__tests__/platformUsername.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Import page: pasting or blurring a profile URL into either username field visibly replaces it with the bare username; Enter-to-submit also normalizes"
    requirement: "QUICK-IQ1"
    verification:
      - kind: unit
        ref: "frontend/src/pages/__tests__/Import.stateMachine.test.tsx#Import page profile-URL extraction"
        status: pass
    human_judgment: false
  - id: D3
    description: "extract_platform_username (backend) mirrors the frontend util, plus the platform=None either-form fallback and non-str passthrough"
    requirement: "QUICK-IQ1"
    verification:
      - kind: unit
        ref: "tests/schemas/test_platform_username.py#test_extract_platform_username"
        status: pass
    human_judgment: false
  - id: D4
    description: "ImportRequest.username and UserProfileUpdate.chess_com_username/.lichess_username normalize server-side, platform-aware per field, with the max_length before-validator ordering proven"
    requirement: "QUICK-IQ1"
    verification:
      - kind: unit
        ref: "tests/schemas/test_platform_username.py#test_import_request_long_url_normalized_before_max_length_check"
        status: pass
      - kind: unit
        ref: "tests/schemas/test_platform_username.py#test_user_profile_update_field_pinned_to_its_own_platform"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-08-09
status: complete
---

# Phase 260809-iq1: Extract username from pasted chess.com/lichess links Summary

**Shared regex-based normalizer (frontend TS + backend Pydantic) strips chess.com/lichess profile URLs down to the bare username on paste, blur, and API submission.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 2
- **Files modified:** 8 (4 created, 4 modified)

## Accomplishments
- `extractPlatformUsername` (frontend) and `extract_platform_username` (backend) — two structurally identical regex-based normalizers, each with named constants for host/marker/character-class so they stay legible as a pair.
- Import page wired end-to-end: `onPaste` (only intercepts when a URL is actually recognized, otherwise lets the browser's normal paste proceed), `onBlur`, and `handleSync`'s submit path (covers Enter, which fires before blur) all route through the util. No error state or toast added (D-02 explicitly excludes them).
- `ImportRequest.username` gets a `mode="before"` validator reading the sibling `platform` field via `info.data`, proven to run ahead of `max_length=100` with a >100-char padded-URL test.
- `UserProfileUpdate.chess_com_username` / `.lichess_username` each get their own validator pinned to that field's fixed platform — a chess.com URL pasted into the lichess field is left unchanged (D-03), not silently rewritten.

## Task Commits

1. **Task 1: Frontend URL-to-username extraction, wired end-to-end into the Import page** - `56450b0a2` (feat, tracer)
2. **Task 2: Backend Pydantic normalization for pasted profile URLs** - `a13815dd9` (feat)

_Note: no docs/metadata commit yet — the orchestrator handles that separately per this task's constraints._

## Files Created/Modified
- `frontend/src/lib/platformUsername.ts` - `extractPlatformUsername(input, platform)`, two anchored case-insensitive regexes
- `frontend/src/lib/__tests__/platformUsername.test.ts` - full behavior-table coverage
- `frontend/src/pages/Import.tsx` - `onPaste`/`onBlur` on both `<Input>`s, `handleSync` now normalizes instead of `.trim()`
- `frontend/src/pages/__tests__/Import.stateMachine.test.tsx` - added `describe('Import page profile-URL extraction')` with paste/blur cases
- `app/core/platform_usernames.py` - `extract_platform_username(value, platform=None)`, mirrors the frontend util, plus the `platform=None` either-form fallback and non-`str` passthrough
- `app/schemas/imports.py` - `ImportRequest` gains a `mode="before"` `field_validator("username")`
- `app/schemas/users.py` - `UserProfileUpdate` gains two per-field `mode="before"` validators
- `tests/schemas/test_platform_username.py` - helper + both schemas, 23 test cases

## Decisions Made
- Two short inline `onPaste`/`onBlur` handlers per field rather than a shared handler-factory hook — the plan's interface_context called out that the two fields are cohesive enough not to warrant extraction, and each handler is 6-8 lines.
- `platform=None` fallback tries chess.com then lichess in a fixed order (matches the plan's stated D-03 fallback contract; only reachable when `ImportRequest.platform` itself failed validation, so ordering has no observable effect on valid requests).

## Deviations from Plan

None — plan executed exactly as written. One test-authoring adjustment: the plan's inline `# type: ignore[arg-type]` comment style was updated to the CLAUDE.md-mandated `# ty: ignore[invalid-argument-type]` form (and the parametrized test's `platform` parameter was typed as `UsernamePlatform` instead) to satisfy `uv run ty check` with zero errors — not a deviation from behavior, just from an illustrative comment in the plan text.

## Issues Encountered

`ty check` flagged one of the two intentionally-mistyped non-str test calls (`extract_platform_username(123, "chess.com")`) as an *unused* ignore comment rather than a real type error — the `int` literal passed ty's narrowing in a way the `None` case didn't. Removed the redundant ignore rather than fight the tool; the runtime `isinstance` behavior is still exercised and asserted.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
Both fields on the Import page and both server-side schemas (`ImportRequest`, `UserProfileUpdate`) now share one normalization contract. No blockers; no follow-up work identified.

---
*Phase: 260809-iq1*
*Completed: 2026-08-09*

## Self-Check: PASSED

All created files found on disk; both task commits (`56450b0a2`, `a13815dd9`) confirmed in git log.
