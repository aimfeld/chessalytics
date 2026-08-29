---
schema_version: 1
open_count: 6
waived_count: 0
fixed_count: 2
total_count: 8
last_updated: 2026-08-28T20:23:06.035Z
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
| 6 | 211 | skipped-test | frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx |  | ORACLE-01 free-play root-ply test skipped: Phase 205 guarantee transiently degraded at width 1 (211-02 Known transient); Plan 211-03 re-points the seam at the server key and must unskip/re-express this test | fixed |  | 2026-08-16T14:34:50.766Z | 2026-08-16T14:55:04.258Z |
| 7 | 213 | deviation | frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts |  | markEngineAssetFailed shipped in Task 1 with no production caller (Plan 04 owns wiring it); Task 2 added a direct unit test to close the knip dead-export gap rather than inventing a caller Task 1 forbade. | open |  | 2026-08-28T10:49:36.569Z |  |
| 8 | 213 | unrun-verify | frontend/src/components/bots/EngineReadyGate.tsx |  | G-213-34 cold-cache Slow-4G Network-tab human-check (213-07 Task 2 <verify><human-check>) not yet run — deferred to end-of-phase UAT per human_verify_mode default | closed | Run across the 213-08..12 UAT rounds; final zero-refetch measurement approved by the user 2026-08-29 (213-12 Task 4 checkpoint, commit 197b1c37e). | 2026-08-28T20:23:06.035Z | 2026-08-29 |

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
  },
  {
    "id": 6,
    "kind": "skipped-test",
    "phase": "211",
    "file": "frontend/src/components/train/__tests__/TrainSolveScreen.test.tsx",
    "line": null,
    "description": "ORACLE-01 free-play root-ply test skipped: Phase 205 guarantee transiently degraded at width 1 (211-02 Known transient); Plan 211-03 re-points the seam at the server key and must unskip/re-express this test",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-08-16T14:34:50.766Z",
    "resolved_at": "2026-08-16T14:55:04.258Z"
  },
  {
    "id": 7,
    "kind": "deviation",
    "phase": "213",
    "file": "frontend/src/lib/engine/__tests__/engineAssetProgress.test.ts",
    "line": null,
    "description": "markEngineAssetFailed shipped in Task 1 with no production caller (Plan 04 owns wiring it); Task 2 added a direct unit test to close the knip dead-export gap rather than inventing a caller Task 1 forbade.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-28T10:49:36.569Z",
    "resolved_at": null
  },
  {
    "id": 8,
    "kind": "unrun-verify",
    "phase": "213",
    "file": "frontend/src/components/bots/EngineReadyGate.tsx",
    "line": null,
    "description": "G-213-34 cold-cache Slow-4G Network-tab human-check (213-07 Task 2 <verify><human-check>) not yet run — deferred to end-of-phase UAT per human_verify_mode default",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-28T20:23:06.035Z",
    "resolved_at": null
  }
]
````
