---
id: 260801-tu5
description: Prevent mobile screen dimming/lock during Train solve via Screen Wake Lock API
status: complete
date: 2026-08-01
commit: 20229491e
---

# Quick Task 260801-tu5 — Summary

## What shipped

A `useWakeLock()` hook holding a Screen Wake Lock for as long as
`TrainSolveScreen` is mounted, so the phone stops dimming and auto-locking
while a user studies a puzzle or reads its reveal.

| File | Change |
|---|---|
| `frontend/src/hooks/useWakeLock.ts` | New. No-arg hook, mount-scoped lock. |
| `frontend/src/components/train/TrainSolveScreen.tsx` | Calls `useWakeLock()` unconditionally next to `useMarkPlayActive()`. |
| `frontend/src/hooks/__tests__/useWakeLock.test.ts` | New. 6 cases. |
| `CHANGELOG.md` | User-facing bullet under `[Unreleased] → Added`. |

## Decisions honored

- Unconditional on the solve screen — no setting, no toggle.
- Scope is `TrainSolveScreen` only; the start and score screens deliberately
  do not hold the lock.
- Silent failure (no Sentry, no user-facing error) for unsupported browsers,
  insecure contexts, and iOS Low Power Mode refusals.

## The load-bearing part

The API's main failure mode is that the browser releases the sentinel itself
whenever the document goes hidden. Two things are required to survive that,
and each is independently necessary:

1. A `visibilitychange` listener that re-requests on `visible`.
2. Clearing `sentinelRef` from the sentinel's own `release` event — otherwise
   the "already held" guard sees a dead sentinel and blocks re-acquisition.

**Mutation-verified**: removing either one individually makes
`re-acquires after the browser releases the lock and the page becomes visible
again` fail (5 passed / 1 failed in both mutants). The test is not a
presence check.

## Verification

| Gate | Result |
|---|---|
| `npm test -- --run useWakeLock` | 6/6 passed |
| `npm test -- --run` (full suite) | 206 files, 3061 tests passed |
| `npm run lint` | 0 errors (3 pre-existing warnings in `coverage/`, unrelated) |
| `npm run build` (tsc + vite) | passed |
| `npm run knip` | clean |

Backend untouched, so the Python gate was not run.

## Not verified by automation

Real-device behavior. The wake lock cannot be exercised in jsdom or a
desktop headless run. Worth a manual check on a phone: open a Train puzzle,
leave it untouched past the auto-lock timeout, confirm the screen stays on,
then confirm it locks normally on the score screen.

## Out of scope (unchanged)

Bots games, the Analysis board, and any non-Train surface. If the same
reading-state problem shows up there, the hook is reusable as-is.
