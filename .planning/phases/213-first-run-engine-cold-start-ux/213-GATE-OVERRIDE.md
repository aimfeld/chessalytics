# Gate override — Phase 213

## ui.safety-gate (execute:wave:post, Wave 3)

**Gate result:** `{"frontend": true, "hasUiFiles": true, "hasUiSpec": false, "block": true}`
**Message:** "UI files changed in this wave but no UI-SPEC.md exists for Phase 213."
**Disposition:** OVERRIDDEN by the user on 2026-08-28, after being presented as a
blocking halt with the alternatives (run `/gsd-ui-phase 213` first, or stop).

**Reason.** Phase 213 went discuss -> research -> plan without `/gsd-ui-phase`. The gate
is correctly configured (`workflow.ui_safety_gate: true`, and UI-SPECs exist for phases
18, 19, 169, 171, 172); it passed in Waves 1 and 2 with `hasUiFiles: false` and only
tripped once Wave 3 touched the analysis-board components. All five plans were already
implemented, merged and green when it fired, so a UI-SPEC generated now would document
finished code rather than constrain it. The phase's UI decisions were locked in
213-CONTEXT.md and enforced per plan through each plan's `must_haves` truths.

**Not done:** no rule file, capability manifest or config value was edited to silence
this gate. The gate remains active for future phases.
