---
phase: 196
slug: analysis-board-stockfish-root-injection
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
block_on: high
register_authored_at_plan_time: true
created: 2026-07-31
---

# Phase 196 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| (none new) | The phase edits client-side in-memory search-core math, React hook/prop wiring inside one already-loaded page, and adds a developer-run Node measurement script. | UCI strings and a UCI-keyed probability `Record`, both produced by same-origin Maia ONNX / Stockfish WASM workers already inside the browser's trust domain. |
| (none new) | The measurement harness runs locally against vendored engine binaries the repo already ships and already invokes from `scripts/engine-grading-depth-ab.mjs`. | Chess FENs and engine evaluations of them. No credentials, no network call, no server tier, no persisted state. |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-196-01 | Tampering (data integrity, not adversarial) | Stale prior-position UCI in `budget.extraRootMoves` reaching `dispatchExpansion` | low | accept | Pre-existing containment: `treeCommon.ts`'s `applyUciMoveFen` returns null on an illegal/malformed UCI at that FEN rather than throwing — a stale UCI yields no child, not a corrupt tree. | closed |
| T-196-02 | Tampering | Injected UCI absent from `effectivePolicy` producing `NaN`/`Infinity` prior that corrupts the cap's sort comparator | low | mitigate | Verified at `treeCommon.ts:158` (`sum + (effectivePolicy[uci] ?? 0)`) and `:163` (`keptTotal > 0 ? … / keptTotal : 0`). Seeded value is always finite in `[0, 1]`. | closed |
| T-196-03 | Denial of Service (self-inflicted, resource) | Oversized `extraRootMoves` inflating root candidate count past the cap, multiplying per-search Stockfish grade cost | low | mitigate | Verified at `treeCommon.ts:184` (`organicSlots = Math.max(0, ROOT_CANDIDATE_HARD_CAP - injected.length)`) and `:187` (injected itself sliced to the cap). Backed by the over-cap unit test. | closed |
| T-196-04 | Tampering (data integrity, not adversarial) | Superseded prior-position Stockfish PV UCI injected into the current position's search (render-ordering race, not an attack) | low | mitigate | Legality filter at `Analysis.tsx:1161` (`bestSanFromPv(position, uci) !== null`) **plus** the `currentFen` freshness guard at `:1149` added by WR-01's fix (`eebc6d6a`). See "Register accuracy note" below — the plan's original mitigation was insufficient on its own. | closed |
| T-196-05 | Denial of Service (self-inflicted, resource) | Unstable `extraRootMoves` identity causing continuous abort+restart of a ~49 s search, starving the board of any result | medium | mitigate | Shared `NO_EXTRA_ROOT_MOVES` sentinel on every no-op branch (`Analysis.tsx:260`, `:1154`, `:1167-1168`) plus the per-position latch. Enforced by two `toBe` identity assertions (`Analysis.test.tsx:1988`, `:2058`) — a value comparison would pass while the bug is present. | closed |
| T-196-06 | Information Disclosure | Unsliced `RankedLine[]` reaching a component that could render more than intended | low | accept | `FlawChessAgreementVerdict` reads only `.rootMove` and `.practicalScore` and renders at most one matched line; unchanged by this phase, rendering asserted identical regardless of array position. All values are the user's own client-side analysis of their own board. | closed |
| T-196-07 | Tampering (data integrity) | `workerPool.ts` cache extraction silently changing the shipped cache's read gate, keying, LRU touch or merge semantics — corrupting grades for every search including bot play | medium | mitigate | Diff of `workerPool.test.ts` across the phase contains exactly 2 deleted lines, both label-only (a comment header and the `describe()` title, each appending `, INJECT-05`). No `it()` body was edited. All Phase 194 CACHE-01..04 cases pass unchanged. | closed |
| T-196-08 | Repudiation (evidence integrity) | A committed report whose figures cannot be traced to the committed data — the failure mode that makes a "measured, not assumed" requirement hollow | medium | mitigate | Headline datum traces exactly: TSV `fen44` row gives `injected_practical_score=0.987382`, `top_organic_practical_score=0.747761`, `injected_visits=436`, `top_organic_visits=11`; report states 0.987 / 0.748 / 436 / 11. Report-writing commit `48602fe1` touched only the TSV and `report.md` (280 insertions, 0 deletions) — no engine source. | closed |
| T-196-09 | Information Disclosure | Committed TSV or report leaking anything sensitive | low | accept | Contents are chess FENs plus engine evaluations of them. No user data, no credentials, no server state. | closed |
| T-196-SC | Tampering (supply chain) | Package-manager installs | n/a | accept | No `npm`/`pip`/`cargo` install task exists anywhere in this phase — `196-RESEARCH.md` § Package Legitimacy Audit records "Not applicable — no external packages are installed by this phase." No legitimacy checkpoint warranted. | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above `workflow.security_block_on` (high) count toward `threats_open`*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

ASVS V2 (Authentication), V3 (Session Management), V4 (Access Control) and V6 (Cryptography) have no
surface in this phase. V5 (Input Validation) is covered by T-196-01/T-196-04 via pre-existing helpers
rather than new validation logic. No threat reaches the `high` blocking threshold.

---

## Register accuracy note (T-196-04)

Recorded because it bears on how much weight the plan-time register should carry.

`196-02-PLAN.md` dispositioned T-196-04 as mitigated by "`freeRunCommitted`'s existing construction …
plus this plan's new legality filter dropping any UCI for which `bestSanFromPv(position, uci)` is
null." That reasoning was **incomplete**: a stale UCI from the previous position is frequently ALSO
legal in the new position (sibling-branch navigation preserving side-to-move parity), so the legality
filter passes it through. The plan-time threat model did not catch this.

It was caught downstream by code review (`196-REVIEW.md` WR-01), independently re-derived by the
phase verifier, and fixed in `eebc6d6a` by threading a `currentFen` out of both
`useStockfishEngine` and `useFlawChessEngine` and gating the injection effect on both matching
`position`. The fix was proven load-bearing by revert-then-restore: removing only the guard fails the
new regression test with `expected [ 'e2e4', 'g1f3' ] to deeply equal []`.

T-196-04 is closed on the strength of the shipped guard, not on the plan's original reasoning.

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| R-196-01 | T-196-01 | Stale-UCI containment is pre-existing and verified (`applyUciMoveFen` returns null, no throw). No new control needed; T-196-04's guard now also prevents the stale UCI arriving in the first place. | Plan 196-01 threat model | 2026-07-31 |
| R-196-02 | T-196-06 | Consuming component reads only two fields and renders at most one line; all data is the user's own client-side analysis of their own board. | Plan 196-02 threat model | 2026-07-31 |
| R-196-03 | T-196-09 | Committed artifacts are chess FENs and engine evaluations. No user data, credentials, or server state. | Plan 196-03 threat model | 2026-07-31 |
| R-196-04 | T-196-SC | No package-manager install task exists in the phase; the gate has no surface to guard. | 196-RESEARCH.md § Package Legitimacy Audit | 2026-07-31 |

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-07-31 | 10 | 10 | 0 | Claude (/gsd-secure-phase, L1 short-circuit) |

Classification depth: ASVS L1 grep-depth verification of each `mitigate` disposition against the
shipped implementation, plus documentation review of each `accept`. Per the workflow's short-circuit
rule (`threats_open: 0` AND `register_authored_at_plan_time: true` AND `asvs_level == 1`), no separate
`gsd-security-auditor` pass was spawned — L1 depth is sufficient and the register was authored at
plan time rather than reconstructed retroactively.

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-07-31
