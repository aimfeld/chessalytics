---
phase: 218-backend-onnxruntime-parity-spike-python-3-14-chain
plan: 01
subsystem: infra
tags: [onnxruntime, onnxruntime-node, maia, parity-spike, dependency-bump, python-3.14]

# Dependency graph
requires:
  - phase: 217-backend-onnxruntime-parity-spike-python-3-14-chain
    provides: onnxruntime-web 1.29.0 already validated in the browser runtime (Phase 217 D-08), which is a *different* compiled artifact and does not stand in for this native-core measurement
provides:
  - "Committed evidence that the native onnxruntime core (Python + Node bindings, not the WASM/web build) does not segfault or diverge past PARITY_EPSILON at 1.29.0 on the vendored maia3_simplified.onnx"
  - "A same-environment 1.20.1 control run anchoring the 1.29.0 candidate number"
  - "Verdict recorded at every pin-rationale site (scripts/maia_parity_spike.py comment block, pyproject.toml maia-inference group, scripts/package.json description, SEED-162 cluster 4 status line)"
  - "Human go/no-go answered: proceed — unblocks 218-02 (raise the pins) and 218-03 (Python 3.14 chain)"
affects: [218-02-backend-onnxruntime-parity-spike-python-3-14-chain, 218-03-backend-onnxruntime-parity-spike-python-3-14-chain]

# Actuals (#2632)
actuals:
  tokens: 9000
  tasks: 3
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Throwaway-environment parity measurement: `uv run --no-project --with onnxruntime==<version>` for Python, `npm --prefix scripts install --no-save onnxruntime-node@<version>` for Node — neither touches a lockfile or manifest, so a FAIL leaves a clean tree"
    - "Evidence-file convention: two-line header (exact command + run date), raw tee'd stdout, trailing `exit_code=<N>` sourced from `${PIPESTATUS[0]}` so a native SIGSEGV (139) is captured rather than swallowed by the pipe"

key-files:
  created:
    - .planning/phases/218-backend-onnxruntime-parity-spike-python-3-14-chain/218-evidence-onnxruntime-1.20.1-control.txt
    - .planning/phases/218-backend-onnxruntime-parity-spike-python-3-14-chain/218-evidence-onnxruntime-1.29.0-python.txt
    - .planning/phases/218-backend-onnxruntime-parity-spike-python-3-14-chain/218-evidence-onnxruntime-node-1.29.0.txt
  modified:
    - scripts/maia_parity_spike.py
    - pyproject.toml
    - scripts/package.json
    - .planning/seeds/SEED-162-major-dependency-backlog.md
    - scripts/engine_disagreement_study/verify_value_head.mjs

key-decisions:
  - "Checkpoint answered `proceed` (PASS) — both native runtimes clean at 1.29.0, so the phase continues to 218-02 (raise the pins) and 218-03 (Python 3.14 chain) rather than deferring."
  - "assumption_delta_decision honored: the 2026-07-16 baseline paragraph in the PARITY_EPSILON comment block was kept verbatim; the 1.29.0 result was appended as a second dated paragraph, not a replacement — the block is a series, not a latest-only singleton."

patterns-established:
  - "Native-vs-web onnxruntime artifacts are measured separately and never substituted for each other, even at the same version number (Phase 217's onnxruntime-web 1.29.0 pass was explicitly not cited as evidence here)."

requirements-completed: []

coverage:
  - id: D1
    description: "Native onnxruntime (Python) parity at 1.29.0 measured against a same-environment 1.20.1 control, both committed as evidence"
    verification:
      - kind: other
        ref: ".planning/phases/218-backend-onnxruntime-parity-spike-python-3-14-chain/218-evidence-onnxruntime-1.29.0-python.txt (PARITY GATE PASSED, exit_code=0)"
        status: pass
      - kind: other
        ref: ".planning/phases/218-backend-onnxruntime-parity-spike-python-3-14-chain/218-evidence-onnxruntime-1.20.1-control.txt (PARITY GATE PASSED, exit_code=0)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Native onnxruntime-node (Node) parity at 1.29.0 measured via verify_value_head.mjs against the native backend"
    verification:
      - kind: other
        ref: ".planning/phases/218-backend-onnxruntime-parity-spike-python-3-14-chain/218-evidence-onnxruntime-node-1.29.0.txt (All value-head checks passed, exit_code=0)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Verdict written into every pin-rationale site (script comment, pyproject.toml, scripts/package.json, SEED-162) without moving either pinned version string"
    verification:
      - kind: other
        ref: "grep -c '\"onnxruntime==1.20.1\"' pyproject.toml (=1), scripts/package.json onnxruntime-node field (=1.21.1), grep -c 'PARITY_EPSILON: float = 0.010' scripts/maia_parity_spike.py (=1)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Human go/no-go decision made against the committed evidence, not inferred by the executor"
    verification: []
    human_judgment: true
    rationale: "Checkpoint task by design — this is precisely the decision RESEARCH.md and the plan required a human to make. Answered `proceed`."

# Metrics
duration: 8min
completed: 2026-09-05
status: complete
---

# Phase 218 Plan 01: Native onnxruntime Parity Spike Summary

**Native onnxruntime core (Python `onnxruntime` and Node `onnxruntime-node`) measured clean at 1.29.0 against the vendored maia3_simplified.onnx — no segfault, no tier flip, max per-ply drift 0.004237 vs a 0.010 tolerance — checkpoint answered `proceed`.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-09-05T06:48:08Z (approx, per STATE.md session start)
- **Completed:** 2026-09-05T06:56:00Z (approx)
- **Tasks:** 3 (2 auto/tracer + 1 checkpoint:decision)
- **Files modified:** 7 (3 new evidence files, 4 pin-rationale/status sites)

## Accomplishments

- Measured the native onnxruntime Python core at 1.29.0 in a throwaway `uv run --no-project` environment, anchored by a same-environment control run at the currently pinned 1.20.1.
  - **Control (1.20.1):** `PARITY GATE PASSED`, measured max per-ply drift **0.003844**, `exit_code=0`.
  - **Candidate (1.29.0):** `PARITY GATE PASSED`, measured max per-ply drift **0.004237**, `exit_code=0` — both within `PARITY_EPSILON=0.010`, every ply tier-matched (gem/great/neither) between expected and measured. Classified in words: **clean pass** — no crash, no tolerance breach, no tier flip.
- Measured the native onnxruntime-node core at 1.29.0 via `verify_value_head.mjs` against the `native` backend (see Deviations — the gate previously defaulted away from native and had to be fixed to actually exercise the artifact this task measures). Result: **all five value-head checks passed** (`PASS` on strong-side-to-move, weak-side-to-move, color-mirror encoding, elo_oppo sensitivity, stronger-opponent-lowers-expected-score), `exit_code=0`.
- Wrote the same verdict into all four pin-rationale/status sites — `scripts/maia_parity_spike.py`'s `PARITY_EPSILON` comment block (new dated paragraph appended below the 2026-07-16 baseline, per the plan's `assumption_delta_decision`), `pyproject.toml`'s `maia-inference` group comment, `scripts/package.json`'s `description` field, and `SEED-162-major-dependency-backlog.md`'s Status line and Cluster 4 section — without moving either pinned version string (`onnxruntime==1.20.1` and `onnxruntime-node@1.21.1` both unchanged in this plan).
- Human checkpoint answered: **`proceed`** — phase continues to 218-02 (raise the pins) and 218-03 (Python 3.14 chain).

## Task Commits

Each task was committed atomically:

1. **Task 1: Measure the native onnxruntime core at 1.29.0 end-to-end, in both languages, without touching a lockfile** - `172827116` (feat, tracer)
2. **Task 2: Write the verdict into every pin-rationale site and the seed, without moving a pin** - `a3143f072` (docs)
3. **Task 3: checkpoint:decision — proceed or defer** - no code commit; decision recorded here and folded into this plan's metadata commit

**Plan metadata:** committed alongside this SUMMARY.

## Files Created/Modified

- `.planning/phases/218-backend-onnxruntime-parity-spike-python-3-14-chain/218-evidence-onnxruntime-1.20.1-control.txt` - control run, PARITY GATE PASSED, drift 0.003844
- `.planning/phases/218-backend-onnxruntime-parity-spike-python-3-14-chain/218-evidence-onnxruntime-1.29.0-python.txt` - candidate run, PARITY GATE PASSED, drift 0.004237
- `.planning/phases/218-backend-onnxruntime-parity-spike-python-3-14-chain/218-evidence-onnxruntime-node-1.29.0.txt` - Node native-backend run, all value-head checks passed
- `scripts/maia_parity_spike.py` - second dated measurement paragraph appended to the `PARITY_EPSILON` comment block; deviation fix to `verify_value_head.mjs`'s gate to explicitly request the `native` backend
- `pyproject.toml` - `maia-inference` group comment records the 1.29.0 PASS and evidence path; pin string unchanged
- `scripts/package.json` - `description` field records the Node-side 1.29.0 PASS and evidence path; `onnxruntime-node` pin unchanged at `1.21.1`
- `.planning/seeds/SEED-162-major-dependency-backlog.md` - Status line and Cluster 4 section updated: spike passed 2026-09-05, evidence path recorded, version bump proceeding in 218-02

## Decisions Made

- **Checkpoint decision: `proceed`.** Both native runtimes (Python and Node) passed cleanly at 1.29.0 with no crash, no tolerance breach, and no tier flip. Per the plan's PASS-branch instructions, 218-02 will raise both pins and 218-03 continues the Python 3.14 chain.
- **assumption_delta_decision honored:** the block is a series (2026-07-16 baseline + 2026-09-05 measurement), not a latest-only singleton — both paragraphs coexist in `scripts/maia_parity_spike.py`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `verify_value_head.mjs` did not request the native onnxruntime-node backend**
- **Found during:** Task 1 (Run C, the Node measurement)
- **Issue:** The script's provider-selection call to `scripts/lib/node-engine-providers.mjs` did not explicitly request the `native` backend, meaning the gate this plan relies on to prove "the native core doesn't crash/diverge" could silently exercise a different (non-native) code path — which would make the whole Node-side measurement meaningless for this plan's purpose.
- **Fix:** Updated the gate to explicitly request backend `'native'` in `createMaiaSession`, so the harness is provably exercising the same native `.node` addon that the FastAPI/worker processes load in production.
- **Files modified:** `scripts/engine_disagreement_study/verify_value_head.mjs`
- **Verification:** Re-ran the harness after the fix; evidence file header explicitly notes "(backend='native' fix applied — see Deviations)" and all five checks pass with `exit_code=0`.
- **Committed in:** `172827116` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug fix, Rule 1)
**Impact on plan:** Necessary for measurement validity — without it, Run C would not have proven what the plan claims it proves (native-core parity). No scope creep; the fix is scoped entirely to the measurement harness this task already touches.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- 218-02 is unblocked: its precondition (this plan's evidence files showing a clean PASS on both native runtimes) is satisfied and checkable mechanically against the three committed evidence files.
- 218-03 (Python 3.14 chain) follows 218-02 per the phase's strict dependency chain.
- No blockers or concerns carried forward from this plan.

---
*Phase: 218-backend-onnxruntime-parity-spike-python-3-14-chain*
*Completed: 2026-09-05*

## Self-Check: PASSED

- `.planning/phases/218-backend-onnxruntime-parity-spike-python-3-14-chain/218-evidence-onnxruntime-1.20.1-control.txt` — FOUND
- `.planning/phases/218-backend-onnxruntime-parity-spike-python-3-14-chain/218-evidence-onnxruntime-1.29.0-python.txt` — FOUND
- `.planning/phases/218-backend-onnxruntime-parity-spike-python-3-14-chain/218-evidence-onnxruntime-node-1.29.0.txt` — FOUND
- Commit `172827116` — FOUND in `git log --oneline --all`
- Commit `a3143f072` — FOUND in `git log --oneline --all`
- `pyproject.toml` pin `"onnxruntime==1.20.1"` — unchanged, count 1
- `scripts/package.json` `onnxruntime-node` — unchanged, `1.21.1`
- `PARITY_EPSILON: float = 0.010` — unchanged in `scripts/maia_parity_spike.py`
