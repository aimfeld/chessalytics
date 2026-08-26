---
phase: quick-260826-qdl
plan: 01
subsystem: frontend-import
tags: [import, paste, analysis-board, sessionStorage]
status: complete
dependency-graph:
  requires: []
  provides:
    - frontend/src/lib/pastedGameHandoff.ts (sessionStorage handoff carrier)
  affects:
    - frontend/src/pages/Import.tsx
    - frontend/src/pages/Analysis.tsx
tech-stack:
  added: []
  patterns:
    - "sessionStorage one-shot destructive-read handoff (mirrors trainRevealCache.ts)"
key-files:
  created:
    - frontend/src/lib/pastedGameHandoff.ts
    - frontend/src/lib/__tests__/pastedGameHandoff.test.ts
    - frontend/src/pages/__tests__/Import.pasteHandoff.test.tsx
  modified:
    - frontend/src/lib/analysisUrl.ts
    - frontend/src/pages/Import.tsx
    - frontend/src/pages/Analysis.tsx
    - frontend/src/pages/__tests__/Analysis.test.tsx
    - frontend/src/pages/__tests__/Import.queuedState.test.tsx
    - frontend/src/pages/__tests__/Import.stateMachine.test.tsx
    - CHANGELOG.md
decisions:
  - "One sessionStorage carrier for both FEN and PGN kinds, consumed by calling Analysis.tsx's existing handlePasteLoad verbatim (per plan investigation findings) — no new board-apply logic, no ?fen=/?line= write-back."
metrics:
  duration: "~35 minutes"
  completed: 2026-08-26
actuals:
  tokens: 8060
  tasks: 3
  commits: 3
---

# Phase quick-260826-qdl Plan 01: Import-tab paste entry point Summary

Added an `Import Single Game (PGN/FEN)` button below the lichess card on the Import tab that opens the existing `PasteModal` and hands off the parsed result to the analysis board via a new one-shot `sessionStorage` carrier, since `?line=`/`?fen=` cannot represent a custom-root PGN or its parsed headers.

## What Was Built

- **`frontend/src/lib/pastedGameHandoff.ts`** (new) — `savePastedGameHandoff`/`takePastedGameHandoff`, modeled on `trainRevealCache.ts`. Destructive read (clears the key on every call, including malformed payloads), private shape-validating type guard, `sessionStorage`-only (never `localStorage`, where the auth token lives), never throws.
- **`frontend/src/lib/analysisUrl.ts`** — exported the previously-private `ANALYSIS_PATH` constant so Import.tsx doesn't hand-write `/analysis`.
- **`frontend/src/pages/Import.tsx`** — mounts a second `PasteModal` instance (same shared component, no fork), a `btn-import-single-game` trigger button (`variant="brand-outline"`) directly after the lichess card, and two handlers: `handlePasteLoad` (writes the handoff, navigates to `/analysis`) and `handlePasteSaved` (navigates straight to `/analysis?game_id=N`, mirroring the on-board path — no handoff needed for a saved game). The modal is mounted outside the `profileLoading` ternary so a mid-flight profile refetch can't unmount it while open.
- **`frontend/src/pages/Analysis.tsx`** — a mount-once effect (guarded by a `pasteHandoffConsumed` ref against StrictMode double-invocation) that calls `takePastedGameHandoff()` and, when present and not overridden by `?game_id=` game mode, claims the shared `seededKey` arbiter and calls the existing `handlePasteLoad` verbatim — the same function the on-board paste button already uses, so both entry points apply a paste identically.
- **Tests**: end-to-end Import-tab coverage (`Import.pasteHandoff.test.tsx`), handoff module unit tests (round-trip, one-shot, corrupt JSON, wrong shape), and an Analysis-page consume describe block (PGN mainline seeding, header rendering, FEN handoff, game-mode precedence, one-shot proof via a second mount).
- **`CHANGELOG.md`** — one `### Added` bullet under `## [Unreleased]`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Two existing Import test harnesses broke after Task 1's unconditional PasteModal mount**
- **Found during:** Task 3's full-suite gate run.
- **Issue:** `Import.queuedState.test.tsx` and `Import.stateMachine.test.tsx` both mocked `useQueryClient` to a bare stub (`{ invalidateQueries: vi.fn() }`) without a real `QueryClientProvider`. `PasteModal`'s `useSavePastedGame` hook calls the real `useMutation`, which internally calls the library's own (unmocked) `useQueryClient` via a direct cross-file import inside `@tanstack/react-query` itself — a named-export module mock never reaches that internal call, so both files threw `"No QueryClient set, use QueryClientProvider to set one"` on every render of `ImportPage`. This is the exact landmine the plan flagged for the *new* test file; it also broke the two *pre-existing* harnesses because they render the same now-changed `ImportPage`.
- **Fix:** Removed the `vi.mock('@tanstack/react-query', ...)` stub from both files and wrapped their `renderImport()` helper in a real `QueryClientProvider` (same pattern the plan mandated for `Import.pasteHandoff.test.tsx`). Also extended their `@/api/client` mock to include `post: vi.fn()` for consistency (the mutation is never actually fired in these tests, so this is defensive, not load-bearing).
- **Files modified:** `frontend/src/pages/__tests__/Import.queuedState.test.tsx`, `frontend/src/pages/__tests__/Import.stateMachine.test.tsx`
- **Commit:** a95d63c38

## Verification

- `cd frontend && npm run lint` — clean.
- `cd frontend && npm test -- --run` — 3595/3597 passed. The 2 failures (`Train.guestGate.test.tsx`) are a pre-existing, unrelated flake (documented project memory: heavy-test 1000ms `waitFor` ceiling under full-suite parallel load) — confirmed by re-running that file in isolation, where it passes 6/6. No file this plan touched is implicated.
- `cd frontend && npm run build` — `tsc -b` + vite build clean.
- `cd frontend && npm run knip` — clean, no unused exports.
- `grep -rn "data-umami-event" frontend/src/pages/Import.tsx` — only the pre-existing `signup-cta` guest-promo attributes; none on the new button.

## Self-Check: PASSED

All files listed under `key-files` exist on disk; all three commits (`fa0d88fde`, `6d2925831`, `a95d63c38`) are present in `git log`.
