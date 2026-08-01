---
phase: 199
slug: bot-re-calibration-sweep-strength-curve-refit
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-31
---

# Phase 199 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
>
> **Read this caveat first.** This phase's deliverable is a *measurement*, not a feature. The real
> "full suite" is the sweep itself, and its pass/fail signal is D-03's pre-registered parity
> threshold, not a green test run. Automated tests here exist to protect the *instrument* (the
> ledger schema, the pooling arithmetic, the resume path) so that a multi-hour run cannot be
> invalidated by a code defect discovered afterwards. Do not confuse a green check suite with
> parity holding — they answer different questions.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node: the `.check.mjs` fixture-self-test convention (no vitest/jest wiring exists for `scripts/`). Python: the argparse `--self-test` / `--bootstrap` convention (e.g. `scripts/calibration_persona_fit.py --self-test`) — **not** under `uv run pytest`, whose config only discovers `tests/` |
| **Config file** | none dedicated — `.check.mjs` files run directly |
| **Quick run command** | `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/lib/<name>.check.mjs` |
| **Full suite command** | none — these are standalone scripts, not aggregated into one runner |
| **Estimated runtime** | seconds per check (the real sweep is hours and is NOT a test) |

---

## Sampling Rate

- **After every task commit:** run the relevant `.check.mjs` / `--self-test` (seconds)
- **After every plan wave:** re-run all checks touched by that wave
- **Before launching the sweep:** every instrument check must be green — a defect found mid-run
  costs the whole run
- **Phase gate:** the written parity verdict against D-03's pre-registered threshold
- **Max feedback latency:** ~10 seconds for instrument checks

---

## Per-Task Verification Map

*Seeded by plan-phase; the planner fills task IDs when PLAN.md is written.*

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| TBD | TBD | 0 | D-08 ledger schema | unit | new `.check.mjs` — new columns present, `--resume` round-trips a post-change ledger, a pre-change ledger is refused | ❌ W0 | ⬜ pending |
| TBD | TBD | 0 | D-03 pooled shift | unit | new script `--self-test` on synthetic before/after numbers | ❌ W0 | ⬜ pending |
| TBD | TBD | 0 | A-02 timing baseline parse | unit | parser `--self-test` on a committed log excerpt fixture | ❌ W0 | ⬜ pending |
| TBD | TBD | 1 | RECAL-01 (re-scoped) | integration | tiny real run (`--games-per-cell 1`, 2 anchors, seconds) asserting row count + anchor set | ❌ W0 | ⬜ pending |
| TBD | TBD | 1 | RECAL-04 resumability | integration | kill a tiny real run mid-flight, confirm `--resume` completes it and loses at most the in-flight game | plumbing exists, smoke test does not | ⬜ pending |

---

## Wave 0 Requirements

- [ ] A `.check.mjs` covering the D-08 ledger schema change — new columns present, `--resume`
      round-trips against a post-change ledger, and a pre-D-08 ledger is refused loudly.
      Note: `--resume`'s header check is by **position and exact order**, not by name
      (`calibration-harness.mjs`, `readPriorLedgerRows`), so appending columns is a hard schema
      break for old ledgers by design. That is acceptable here — no run in this phase starts from
      a pre-D-08 ledger — but the check must pin the behavior so it stays deliberate.
- [ ] A small Python script computing the D-03 pooled shift, with its own `--self-test` on
      synthetic numbers run **before** it is ever pointed at real data. Mirror
      `calibration_anchor_fit.py:669-700` (`combine_preset_g_preset`) for the SE-from-CI-width +
      inverse-variance pooling; do not hand-roll the formula.
- [ ] A parser for the pre-195 `run.log` timing lines with a `--self-test` over a small committed
      excerpt fixture, plus the derived baseline artifact it emits (per A-02: commit the derived
      baseline, not the ~17.5 MB of raw logs).

*Nothing in Wave 0 blocks the "start it and observe early results" working style — but the D-08
ledger columns and the D-03 threshold must both be settled and green before the sweep launches,
because neither is fixable after the fact without re-running.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| The sweep itself | RECAL-01 (re-scoped) | Multi-hour supervised run; the measurement IS the deliverable | Launch under `bin/preset-supervisor.sh`, observe streaming ledger rows, confirm the run reaches a clean `-cells.tsv` |
| Crash/resume under real conditions | RECAL-04 | The wasm OOB failure mode appears only ~5-6h into a blend>0 run and cannot be forced on demand | If it fires, confirm the supervisor restarts with `--resume` and that at most the in-flight game is lost |
| Parity verdict | RECAL-01/02/03 (re-scoped) | A judgement against a pre-registered threshold, not an assertion | Compare per-family pooled shift to the D-03/A-04 thresholds fixed **before** the run; apply the null-control validity gate first |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Instrument checks green **before** the sweep launches
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
