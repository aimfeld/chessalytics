---
phase: 205
slug: train-grading-oracle-agreement
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-08-04
---

# Phase 205 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

Register origin: **authored at plan time** — both `205-01-PLAN.md` and `205-02-PLAN.md`
carry a parseable `<threat_model>` block. Verification depth: ASVS level 1 (grep-depth),
block threshold `high`. No `high` or `critical` threat is present in the register.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| sessionStorage → React state | `trainRevealCache` is same-origin, same-tab storage the page itself wrote; trivially editable from devtools, and now read back carrying an engine-derived `lines` array. | Client-side Stockfish rank lines for a position already on the user's own board |
| Stockfish WASM Worker → hook state | Engine output crosses into grading state. Pre-existing and unchanged in kind; phase 205 changes only which of two Workers answers the root ply. | Engine evaluations (cp/mate/pv) |
| HTTP request → repository | `user_id` reaches every selection site from the authenticated principal, never from a request body or query parameter. Pre-existing; phase 205 must not weaken it. | Authenticated principal identity |
| Eval pipeline → `game_flaws.missed_pv_lines` | The JSONB blob the new predicate reads is written exclusively by the server-side eval pipeline and by worker submissions the server validates. Not user-authored content. | Server-written answer-key blob |
| Nav badge render → `get_waiting_puzzle_count` | A hot, frequently-rendered COUNT path that now carries a JSONB-derived predicate. | Per-user due-item counts |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-205-01 | Tampering | `trainRevealCache` restored `gradeResult.lines` → `freePlaySeedEval` → `useTrainFreePlay` | low | mitigate | Verified: single nullish default `gradeResult.lines ?? []` (`frontend/src/components/train/TrainSolveScreen.tsx:289`); rank lookups return `null` on no match (`frontend/src/hooks/uciParser.ts`); `isCachedTrainReveal` still gates the restore path and rejects non-object payloads (`frontend/src/lib/trainRevealCache.ts:49,72`). Worst outcome of a tampered entry is a locally-displayed badge on the tamperer's own reveal — the solve verdict was already submitted before the cache is written. | closed |
| T-205-02 | Information disclosure | `GradeResult.lines` | low | accept | Client-side Stockfish output for a position already rendered on the user's own board; the reveal already displays rank 1 plus up to three alternatives. No server secret, no other user's data, no new network payload. | closed |
| T-205-03 | Elevation of privilege | free-play grading path | low | accept | Free-play grades are display-only. The scored solve verdict comes from the session-scoped grading engine and was already submitted; no free-play value can change a stored score or an SR ladder outcome. | closed |
| T-205-04 | Elevation of privilege | `dead_band_admissible` composed into `pool_entry_stmt` / `due_stmt` / the due-count statement | medium | mitigate | Verified: the predicate appears only as an additional conjunct inside `.where(...)` lists that already carry their own `user_id` equality (`GameFlaw.user_id == user_id` in `pool_entry_stmt`; `DrillItem.user_id == user_id` in `due_stmt` and the due-count statement). No `or_()`, no new join, no subquery over another user's rows. Every new test seeds its own user, so a cross-user leak would surface as a wrong count. | closed |
| T-205-05 | Denial of service | `get_waiting_puzzle_count`'s due-count statement | medium | mitigate | Verified: `dead_band_admissible` contains zero `select(` / `.join(` / `exists(` — it is a pure SQL expression, so the row count entering the predicate is unchanged. It remains bounded by the statement's existing `user_id` + ACTIVE + due-date filters (tens of rows for one user). If a plan regression appears in prod, the mitigation is to reshape the statement (Phase 190 precedent), not to remove the band — removing it would break the mirror contract with the composition scan. | closed |
| T-205-06 | Tampering | `game_flaws.missed_pv_lines` as the band's input | low | accept | The blob is server-written. A malformed or degenerate blob is handled as a total operator (returns NULL, excludes the row) rather than raising — the conservative direction: an unreadable answer key results in NOT serving the puzzle. Independently corroborated by `205-REVIEW.md` ("every clause is a NULL-safe total operator"). | closed |
| T-205-07 | Repudiation | lazy eviction leaves no audit trail | low | accept | By design (`drill_item.py` D-02): a skipped item is skipped for one session only, with no state change to record. Adding an audit write would violate the never-write rule this phase depends on. | closed |
| T-205-SC | Tampering | npm/pip/cargo installs | low | accept | No package-manager install task exists in this phase — `205-RESEARCH.md` § "Standard Stack" confirms zero new dependencies, so no Package Legitimacy Audit is required and no install checkpoint is warranted. | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| R-205-01 | T-205-02 | Rank lines are client-side engine output for the user's own board; the reveal already shows rank 1 and three alternatives. No new network payload. | Adrian Imfeld (plan-time disposition) | 2026-08-04 |
| R-205-02 | T-205-03 | Free-play grades are display-only and cannot alter a stored score or SR ladder outcome. | Adrian Imfeld (plan-time disposition) | 2026-08-04 |
| R-205-03 | T-205-06 | Input blob is server-written; degenerate input fails closed (row excluded), never raises. | Adrian Imfeld (plan-time disposition) | 2026-08-04 |
| R-205-04 | T-205-07 | Absence of an audit trail on lazy eviction is required by the phase's never-write rule (D-02 / criterion 4). | Adrian Imfeld (plan-time disposition) | 2026-08-04 |
| R-205-05 | T-205-SC | Zero new dependencies in this phase; no install surface exists to audit. | Adrian Imfeld (plan-time disposition) | 2026-08-04 |

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-04 | 8 | 8 | 0 | /gsd-secure-phase (ASVS L1 short-circuit — register authored at plan time, threats_open 0) |

Corroborating evidence from the same phase: `205-REVIEW.md` (`status: clean`, 0 findings)
independently traced the `dead_band_admissible` / `mover_color_expr` NULL semantics and
confirmed the predicate is applied identically at all three selection sites with no drift.

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-08-04
