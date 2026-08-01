# Phase 198 — Spec-less Edge Probe (raw output)

**Produced:** 2026-07-31 by `/gsd-plan-phase 198`, step 7.95 (spec-less probe fallback).
**Why this file exists:** Phase 198 has no `SPEC.md`, so both `## Edge Coverage` and `## Prohibitions`
were absent and the fallback protocol authored the predicates directly into the plans' `must_haves`.
The plan-checker flagged that the "21 edges in, 21 accounted for" claim had no auditable source
artifact — a phase-wide count of `must_haves.truths` across the 8 plans is much larger than 21,
because most truths are plan-authored rather than probe-derived. This file is that source, so the
reconciliation can be checked independently.

**Scope note (the thing that made the count look wrong):** the probe emits edges **per requirement**,
not per plan and not per truth. 21 rows here map onto a subset of the plans' `must_haves`; the
remaining truths in those plans come from CONTEXT.md decisions, ROADMAP success criteria, and
RESEARCH.md's validation architecture. Only the 21 rows below are probe-derived.

## Invocation

```
node ~/.claude/gsd-core/bin/lib/edge-probe.cjs <reqs.json>
```

with `<reqs.json>` populated from `.planning/REQUIREMENTS.md` lines 78-88 (DISPATCH-01..11 verbatim).

## Coverage summary as emitted

```json
{"applicable":21,"resolved":0,"unresolved":21,"byVerification":{"explicit":0,"backstop":0}}
```

All 21 rows came back `unresolved` — the engine proposes probes, the planner resolves them under the
§A `--auto` rules (auto-`covered` → plain `must_haves.truths` string; else auto-`backstop` → structured
flat-scalar `{ statement, verification: backstop }`; `unclassified` never auto-resolved).

## Raw items

| # | Requirement | Category | Probe |
|---|---|---|---|
| 1 | DISPATCH-01 | idempotency | What happens if this runs twice on the same input? |
| 2 | DISPATCH-01 | concurrency | If interrupted or run in parallel, what is guaranteed? |
| 3 | DISPATCH-02 | unclassified | unclassified — review manually |
| 4 | DISPATCH-03 | adjacency | When two things are exactly equal or just touch, do they merge, collide, or separate? |
| 5 | DISPATCH-03 | empty | What is the result for empty, single-element, or null input? |
| 6 | DISPATCH-03 | ordering | When elements compare equal, is output order specified and stable? |
| 7 | DISPATCH-04 | unclassified | unclassified — review manually |
| 8 | DISPATCH-05 | boundary | What happens exactly at each min/max/threshold — and one step either side? |
| 9 | DISPATCH-05 | adjacency | When two things are exactly equal or just touch, do they merge, collide, or separate? |
| 10 | DISPATCH-05 | empty | What is the result for empty, single-element, or null input? |
| 11 | DISPATCH-05 | ordering | When elements compare equal, is output order specified and stable? |
| 12 | DISPATCH-05 | precision | Where can precision loss, overflow, or rounding/tie-breaking occur — and what is the exact contract? |
| 13 | DISPATCH-06 | boundary | What happens exactly at each min/max/threshold — and one step either side? |
| 14 | DISPATCH-06 | precision | Where can precision loss, overflow, or rounding/tie-breaking occur — and what is the exact contract? |
| 15 | DISPATCH-07 | idempotency | What happens if this runs twice on the same input? |
| 16 | DISPATCH-07 | concurrency | If interrupted or run in parallel, what is guaranteed? |
| 17 | DISPATCH-08 | unclassified | unclassified — review manually |
| 18 | DISPATCH-09 | concurrency | If interrupted or run in parallel, what is guaranteed? |
| 19 | DISPATCH-10 | boundary | What happens exactly at each min/max/threshold — and one step either side? |
| 20 | DISPATCH-10 | precision | Where can precision loss, overflow, or rounding/tie-breaking occur — and what is the exact contract? |
| 21 | DISPATCH-11 | unclassified | unclassified — review manually |

## Disposition claimed by the planner

| Disposition | Count | Where |
|---|---|---|
| Authored as a plain `must_haves.truths` string | 16 | across the 8 plans |
| Authored as a `{ statement, verification: backstop }` marker | 1 | DISPATCH-05 precision (row 12) |
| Left `unresolved`, surfaced as a `<flagged_assumptions>` block | 4 | the four `unclassified` rows: DISPATCH-02 (198-04), -04 (198-06), -08 (198-08), -11 (198-07) |
| **Total** | **21** | no-silent-drop equality holds |

The four `unclassified` rows are correct to leave unresolved: §A forbids auto-`backstop`ping them, and
each is a requirement whose "edge" is a judgement or a measurement outcome rather than a code
boundary (a pre-declared band verdict, a bit-identity assertion, a real-engine gate, a preserved
contract). The plan-checker independently confirmed the 4-unresolved count against the plans.
