---
phase: quick-260807-dr9
plan: 01
subsystem: frontend
tags: [train, sentry, guest-gate, instrument, axios]
status: complete
dependency-graph:
  requires: []
  provides:
    - "TrainGuestGate component (guest sign-up CTA on /train)"
    - "sentryBeforeSend unactionable-network-noise drop branch"
  affects:
    - frontend/src/pages/Train.tsx
    - frontend/src/instrument.ts
tech-stack:
  added: []
  patterns:
    - "profile-gated mount effect via useRef latch instead of empty dep array"
    - "typeof-guarded browser globals in a pre-app-bundle module (instrument.ts)"
key-files:
  created:
    - frontend/src/components/train/TrainGuestGate.tsx
    - frontend/src/pages/__tests__/Train.guestGate.test.tsx
    - frontend/src/__tests__/instrument.beforeSend.test.ts
  modified:
    - frontend/src/pages/Train.tsx
    - frontend/src/pages/__tests__/Train.solveLoop.test.tsx
    - frontend/src/instrument.ts
    - CHANGELOG.md
decisions:
  - "Followed the plan's locked D-01..D-12 decisions verbatim; no deviations required a user call"
metrics:
  duration: "~55 minutes"
  completed: 2026-08-07
actuals:
  tokens: 7067
  tasks: 2
  commits: 2
---

# Phase quick-260807-dr9 Plan 01: Guest gate on Train + drop unactionable Sentry network noise Summary

Two independent, frontend-only Sentry fixes landed as two atomic commits: a guest sign-up gate that stops guests from ever reaching `/train/*` (FLAWCHESS-64), and a `sentryBeforeSend` drop branch that filters axios network-error noise caused by our own hard navigations and iOS Safari backgrounding while still reporting real Caddy/host outages (FLAWCHESS-24).

## What Was Built

**Task 1 — FLAWCHESS-64 (guest gate on /train):**
- `frontend/src/components/train/TrainGuestGate.tsx` (new) — a primary-button (`variant="default"`) sign-up CTA shaped on `NoEngineAnalysisFlawsState.tsx`'s guest branch. Pressing "Sign up free" calls `logoutForPromotion()` from `useAuth()` and then hard-navigates to `/login?tab=register`, mirroring `Import.tsx`'s guest promo flow. Lives in its own file so `useAuth()` never gets pulled into `Train.tsx` itself (keeps the provider-free render in `Train.solveLoop.test.tsx` working).
- `frontend/src/pages/Train.tsx` — reads `is_guest` from `useUserProfile()` (never `useAuth().user`), derives `canTrain = profile != null && !isGuest`, and gates the mount effect that calls `startSession()` behind a `useRef` latch + `canTrain` (replacing the old unconditional `useEffect(() => startSession(), [])`). `useTrainGradingEngine` now receives `enabled: canTrain` instead of a hardcoded `true`. Three render branches were added immediately before the final `return`, after all hooks: guest → `TrainGuestGate` only; profile unresolved (loading or errored) → a status paragraph; otherwise the existing solve-loop UI, unchanged. `App.tsx` was not touched — the Train nav item stays visible to guests.
- `frontend/src/pages/__tests__/Train.guestGate.test.tsx` (new) — covers all four `<behavior>` cases: guest issues zero `/train/*` calls and sees the CTA (not `TrainStartScreen`); pressing the CTA calls `logoutForPromotion()` once and sets `window.location.href`; non-guest composes the session exactly once with no CTA; profile-loading and profile-errored states both issue zero calls.
- `frontend/src/pages/__tests__/Train.solveLoop.test.tsx` — added a `vi.mock('@/hooks/useUserProfile', ...)` returning a settled non-guest profile, since this file's `@/api/client` mock spreads `...actual` (real axios), meaning `useUserProfile` would otherwise never resolve under jsdom and the now-gated `startSession()` would never fire.
- `CHANGELOG.md` — one `### Fixed` bullet under `[Unreleased]`.

**Task 2 — FLAWCHESS-24 (drop unactionable axios network-error noise):**
- `frontend/src/instrument.ts` — added a module-level `isUnloading` flag set by a `'pagehide'` listener (guarded behind `typeof window !== 'undefined'`), an `isSuppressibleNetworkNoise()` helper checking `isUnloading`, `navigator.onLine === false`, and `document.visibilityState === 'hidden'` (each behind its own `typeof` guard, fail-open to reporting), and a `SUPPRESSIBLE_AXIOS_CODES` constant (`ERR_NETWORK`, `ERR_CANCELED`). `sentryBeforeSend` now drops these two codes when the environment reads as suppressible, inserted after the existing 401 drop and before the 500/`ECONNABORTED`/`ERR_NETWORK` fingerprint chain, which is otherwise untouched — a foreground+online `ERR_NETWORK` still ships with the `api-network-error` fingerprint. The function's return type was widened to `Sentry.ErrorEvent | null` (tsc accepted it against the installed `@sentry/react` version) and the two `null as unknown as Sentry.ErrorEvent` casts were dropped; `sentryBeforeSend` is now exported for testing.
- `frontend/src/__tests__/instrument.beforeSend.test.ts` (new) — covers the full `<behavior>` matrix: `ERR_NETWORK`/`ERR_CANCELED` dropped under each of the three suppressible conditions, both kept (with/without fingerprint) when foreground+online, 401 drop / 500 fingerprint / `ECONNABORTED` fingerprint unchanged (including while hidden+offline+unloading, since a timeout means the request was actually attempted), and a non-axios error returned untouched. `vi.resetModules()` + dynamic import per test isolates the module-level `isUnloading` flag across cases.

Knip did not flag the new `sentryBeforeSend` export (its vitest plugin treats the new test file as an entry point), so the plan's `lib/sentryNoise.ts` fallback was not needed.

## Deviations from Plan

None — plan executed exactly as written. Both tasks followed the locked D-01..D-12 decisions verbatim; no Rule 1-4 deviations were required.

## Revert-Proof Verification (D-11)

Performed by actual revert + restore, not grep or symbol presence, for both tasks:

**Task 1:**
1. Removed the `canTrain` guard from the mount effect (`if (hasStartedRef.current || !canTrain) return;` → `if (hasStartedRef.current) return;`). Result: 3 of 5 tests in `Train.guestGate.test.tsx` FAILED — `composeOrResumeSession` and `getProgress` were called even for a guest and an unresolved profile, exactly the FLAWCHESS-64 bug. Restored.
2. Replaced the `isGuest` render branch with `if (false && isGuest)` (simulating removal). Result: 2 of 5 tests FAILED — `train-guest-gate`/`btn-signup-for-train` never rendered; `TrainStartScreen`'s "No puzzles available yet" landing rendered instead. Restored.
3. Re-ran the full targeted suite after restoring both: all 12 tests across `Train.guestGate.test.tsx` + `Train.solveLoop.test.tsx` passed.

**Task 2:**
1. Deleted the new suppressible-code drop branch from `sentryBeforeSend`. Result: 4 of 10 tests in `instrument.beforeSend.test.ts` FAILED (all three drop cases plus the `ERR_CANCELED` three-condition case) — every previously-dropped error now returned with a fingerprint instead of `null`. The 6 keep/unchanged tests (foreground+online keep, 401, 500, ECONNABORTED, non-axios) still passed. Restored.
2. Re-ran: all 10 tests passed after restoring.

## Auth Gates

None encountered.

## Threat Flags

None — the threat register's `T-dr9-01`/`T-dr9-02`/`T-dr9-03` mitigations (backend `_reject_guest` untouched, `logoutForPromotion` reusing the existing already-shipped clear-and-navigate path, the foreground+online `ERR_NETWORK` variant explicitly kept) are all satisfied as designed; no new trust-boundary-crossing surface was introduced.

## Known Stubs

None.

## Verification

Full frontend gate (`npm run lint && npm test -- --run && npm run build && npm run knip`) run and green after each commit:
- After Task 1: lint clean, 3315/3315 tests passed, `tsc -b && vite build` clean, knip clean.
- After Task 2: lint clean, 3325/3325 tests passed (10 new), `tsc -b && vite build` clean (confirming the widened `beforeSend` return type is accepted), knip clean.

`git status --porcelain -- app tests alembic frontend/src/App.tsx frontend/package.json` returned empty after both commits — no backend, `App.tsx`, or `package.json` changes. `git diff origin/main -- frontend/src/App.tsx` is empty.

Two commits landed on `main`, in order:
1. `b9f80e8f3` — `feat(quick-260807-dr9): guest sign-up gate on /train instead of TrainStartScreen` (contains `Fixes FLAWCHESS-64`), touching only the five Task 1 files.
2. `8b4192e6a` — `fix(quick-260807-dr9): drop unactionable axios network-error Sentry noise` (contains `Fixes FLAWCHESS-24`), touching only `frontend/src/instrument.ts` and the new test file.

## Self-Check

- FOUND: frontend/src/components/train/TrainGuestGate.tsx
- FOUND: frontend/src/pages/__tests__/Train.guestGate.test.tsx
- FOUND: frontend/src/__tests__/instrument.beforeSend.test.ts
- FOUND: commit b9f80e8f3 (git log --oneline --all)
- FOUND: commit 8b4192e6a (git log --oneline --all)

## Self-Check: PASSED
