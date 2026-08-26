# Deferred Items — 260826-pn3

## Pre-existing frontend test flake (out of scope)

`src/pages/__tests__/Train.guestGate.test.tsx` — `btn-signup-for-train` `waitFor`
timeout — failed twice under `npm test -- --run` (full suite, resource-contended)
but passed cleanly in isolation both times it was retried. The file has no
dependency on anything this plan touched (`train_scheduler.py`,
`TrainStatsCard.tsx`'s `PARKED_EXPLAINER`, `drill_item.py`, `test_train.py`
docstring, `CHANGELOG.md`) — confirmed via grep, and its last touching commits
are unrelated features (opponent-matching, dead-field cleanup, Train warm-up
sessions).

Matches the documented "Heavy frontend test timeout flake" pattern: two
independent ceilings (Vitest's 5s `testTimeout` and testing-library's default
1000ms `waitFor`), and a bare `waitFor` stack means the 1000ms ceiling is the
one being hit — the per-test timeout does not cover it. Pre-existing, scope
boundary excludes it from this task's auto-fix rules.
