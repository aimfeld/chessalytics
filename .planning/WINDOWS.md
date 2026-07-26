---
schema_version: 1
open_count: 2
waived_count: 0
fixed_count: 0
total_count: 2
last_updated: 2026-07-25T20:27:06.894Z
---

# Broken Windows Ledger

> Cross-phase defect register. `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 190 | deviation | frontend/src/components/train/TrainReveal.tsx |  | Tactic opt-in trigger renders generic 'Step through the tactic line' pre-fetch (not motif-named) since the motif key is only available inside the lazily-fetched TacticLinesResponse, gated by T-190-16's opt-in-only fetch rule | open |  | 2026-07-25T20:27:06.762Z |  |
| 2 | 190 | deviation | frontend/src/components/train/TrainReveal.tsx |  | D-11 miss-reveal sentence omits the illustrative {consequence} clause (e.g. 'losing a rook') since no backend field (SolveResponse/PuzzleRevealResponse) supplies a material-loss description | open |  | 2026-07-25T20:27:06.894Z |  |

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
  }
]
````
