---
schema_version: 1
open_count: 4
waived_count: 0
fixed_count: 1
total_count: 5
last_updated: 2026-08-08T17:58:51.847Z
---

# Broken Windows Ledger

> Cross-phase defect register. With `workflow.windows_enforce` enabled, `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 190 | deviation | frontend/src/components/train/TrainReveal.tsx |  | Tactic opt-in trigger renders generic 'Step through the tactic line' pre-fetch (not motif-named) since the motif key is only available inside the lazily-fetched TacticLinesResponse, gated by T-190-16's opt-in-only fetch rule | open |  | 2026-07-25T20:27:06.762Z |  |
| 2 | 190 | deviation | frontend/src/components/train/TrainReveal.tsx |  | D-11 miss-reveal sentence omits the illustrative {consequence} clause (e.g. 'losing a rook') since no backend field (SolveResponse/PuzzleRevealResponse) supplies a material-loss description | open |  | 2026-07-25T20:27:06.894Z |  |
| 3 | 200 | unrun-verify | frontend/src/components/train/TrainReveal.tsx |  | Phase 200 end-of-phase Human Verification Required browser pass (375px mobile + desktop, 15 steps) not yet run — non-blocking for execution per plan 200-04, but a mandatory pre-squash-merge item covering EXPLORE-07/LEGEND-06's pixel half that jsdom cannot verify | fixed |  | 2026-08-01T13:26:38.534Z | 2026-08-02T15:21:00.103Z |
| 4 | 207 | unrun-verify | .planning/phases/207-self-serve-password-reset/207-03-SUMMARY.md |  | RESET-05 real-mailbox eligibility observation (plan step 9: no-password account produces zero sends with identical confirmation copy) was NOT PERFORMED at the Task 2 checkpoint; automated coverage (TestPasswordResetEligibility) stands in its place | open |  | 2026-08-08T13:27:04.997Z |  |
| 5 | 208 | stub | frontend/src/components/analysis/PasteModal.tsx |  | Analyze full game button is a no-op click handler; wiring to POST /imports/paste + tier-1 enqueue is intentionally deferred to Plan 03 per this plan's own action text | open |  | 2026-08-08T17:58:51.847Z |  |

````json
[
  {
    "id": 1,
    "kind": "deviation",
    "phase": "190",
    "file": "frontend/src/components/train/TrainReveal.tsx",
    "line": null,
    "description": "Tactic opt-in trigger renders generic 'Step through the tactic line' pre-fetch (not motif-named) since the motif key is only available inside the lazily-fetched TacticLinesResponse, gated by T-190-16's opt-in-only fetch rule",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-07-25T20:27:06.762Z",
    "resolved_at": null
  },
  {
    "id": 2,
    "kind": "deviation",
    "phase": "190",
    "file": "frontend/src/components/train/TrainReveal.tsx",
    "line": null,
    "description": "D-11 miss-reveal sentence omits the illustrative {consequence} clause (e.g. 'losing a rook') since no backend field (SolveResponse/PuzzleRevealResponse) supplies a material-loss description",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-07-25T20:27:06.894Z",
    "resolved_at": null
  },
  {
    "id": 3,
    "kind": "unrun-verify",
    "phase": "200",
    "file": "frontend/src/components/train/TrainReveal.tsx",
    "line": null,
    "description": "Phase 200 end-of-phase Human Verification Required browser pass (375px mobile + desktop, 15 steps) not yet run — non-blocking for execution per plan 200-04, but a mandatory pre-squash-merge item covering EXPLORE-07/LEGEND-06's pixel half that jsdom cannot verify",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-08-01T13:26:38.534Z",
    "resolved_at": "2026-08-02T15:21:00.103Z"
  },
  {
    "id": 4,
    "kind": "unrun-verify",
    "phase": "207",
    "file": ".planning/phases/207-self-serve-password-reset/207-03-SUMMARY.md",
    "line": null,
    "description": "RESET-05 real-mailbox eligibility observation (plan step 9: no-password account produces zero sends with identical confirmation copy) was NOT PERFORMED at the Task 2 checkpoint; automated coverage (TestPasswordResetEligibility) stands in its place",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-08T13:27:04.997Z",
    "resolved_at": null
  },
  {
    "id": 5,
    "kind": "stub",
    "phase": "208",
    "file": "frontend/src/components/analysis/PasteModal.tsx",
    "line": null,
    "description": "Analyze full game button is a no-op click handler; wiring to POST /imports/paste + tier-1 enqueue is intentionally deferred to Plan 03 per this plan's own action text",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-08T17:58:51.847Z",
    "resolved_at": null
  }
]
````
