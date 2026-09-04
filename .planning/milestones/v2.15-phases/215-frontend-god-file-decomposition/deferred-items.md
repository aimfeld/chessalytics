# Deferred Items — Phase 215

Out-of-scope discoveries logged during execution, not fixed per the deviation-rules scope
boundary (only auto-fix issues directly caused by the current task's changes).

## 215-01 Task 3

**Pre-existing test-isolation flake: `src/pages/__tests__/Train.guestGate.test.tsx`**

- Found during: Task 3's full-gate checkpoint (`npm test -- --run`).
- Symptom: 2 of 6 tests in `Train.guestGate.test.tsx` fail when the full suite runs
  (`Test Files 1 failed | 249 passed`, `Tests 2 failed | 3882 passed`), but the same file
  passes cleanly in isolation (`npm test -- --run src/pages/__tests__/Train.guestGate.test.tsx`
  → 6/6 passed). Reproduced twice with the full suite, both times the same 2 tests.
- Scope: 215-01 touches only `frontend/eslint.config.js`, `frontend/eslint.config.sonarjs.mjs`,
  `frontend/package.json`, `frontend/package-lock.json`, `docs/dev-tooling.md`, `CLAUDE.md`,
  `frontend/CLAUDE.md` — no `frontend/src/` file was modified, so this is pre-existing
  cross-test-contamination (likely a mock/module-state leak from an adjacent test file in the
  same run), not something 215-01 introduced.
- Not fixed here — out of scope for a lint-config/docs-only plan. Flag for whoever next touches
  `Train.guestGate.test.tsx` or its neighbors, or for a dedicated test-isolation pass.
