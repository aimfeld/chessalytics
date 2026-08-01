---
phase: 197-maia-wdl-leaf-values
verified: 2026-07-31T14:30:00Z
status: passed
score: 7/7 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 6/7 (with the caveat that the 7th was reshaped, not failed)
  gaps_closed:
    - "The single outstanding human-verification item — 'confirm mechanism shipped-but-disabled is the intended final state' — is resolved. The operator did not merely confirm; they overrode it with a stronger disposition: full removal. Verbatim: 'strip the mechanism fully. I don't want to bloat the code for something that turned out to be a bad idea. We still have the trace of experiments and data.' This is a valid, decisive answer to the escalated question, not a non-answer."
  gaps_remaining: []
  regressions: []
gaps: []
human_verification: []
---

# Phase 197: Maia WDL leaf values Verification Report (Re-verification after full strip)

**Phase Goal:** Consume the Maia WDL head already computed and transferred on every `policy()` call as the leaf value for deep tree nodes, instead of discarding it and spending 700-1400 ms of Stockfish on the same node — the single highest-potential (2-5x) lever in SEED-126, shipped as the engine-design change it actually is, with its own move-quality evaluation and its own calibration, not folded in as a speed optimization.

**Verified:** 2026-07-31T14:30:00Z
**Status:** passed
**Re-verification:** Yes — after the operator ordered a full strip of the mechanism (commits `b1764a83`, `7edb14da`, `608aa6af`) in response to the prior verification's escalated human-verification item.

## What changed and why this closes the prior gap

The prior verification (`human_needed`, 6/7) escalated exactly one item: whether "mechanism shipped-but-disabled, retained for a future SEED-128 revisit" was really the intended final state, given it inverted the roadmap's stated 2-5x-lever goal into a fully-disabled production mechanism.

The operator answered directly and went further than the escalation asked for: strip it entirely rather than retain it disabled. That is a legitimate, decisive resolution of the escalated question — not a non-answer, not a rubber stamp, and not a re-opening of a settled human checkpoint. I verified the strip actually happened as claimed (below) rather than accepting the SUMMARY narrative.

**Judgement call on goal achievement (asked for explicitly):** the phase goal said "shipped ... with its own move-quality evaluation." What exists now is *not* a shipped 2-5x lever — it is a rigorously measured, rigorously documented rejection of that lever, evidenced by a pre-committed accept rule, a purpose-built adversarial fixture, and a blocking gate that was proven capable of failing before it was trusted to reject the real thing. The codebase today is bit-identical to its pre-phase state on `frontend/` (verified below), plus a clean, honest paper trail. I score this **passed**, not partial: the ROADMAP's own acceptance criterion for LEAF-04 ("move quality is evaluated on its own terms before the change is accepted") is exactly what happened, and the evaluation is what produced the rejection. A phase whose evidence-based conclusion is "don't ship this" and which then removes every trace of the rejected mechanism from production code, while preserving the expensive-to-redo measurement trail, has achieved everything the roadmap's process required of it. Marking this "partial" would effectively penalize honest negative results relative to a phase that fabricated a marginal accept — which is the wrong incentive to set.

## Direct verification of the strip (not taken on trust)

| # | Check | Command | Result |
|---|-------|---------|--------|
| 1 | Mechanism symbols genuinely absent from source | `grep -rn "wdlLeafExpectedScore\|WDL_LEAF_HANDOFF_DEPTH\|usesWdlLeaf\|wdlLeafHandoffDepth\|getCachedWdl\|makeWdlGatedProviders" frontend/src/ scripts/` | Zero matches (exit 1) |
| 2 | Frontend is byte-identical to pre-phase baseline | `git diff --stat 1f14f5de..HEAD -- frontend/` | Empty — no output, no exit-code diff |
| 3 | Pre-existing WDL infra (not Phase 197's to touch) survived | `git diff 1f14f5de..HEAD -- frontend/src/lib/maiaEncoding.ts frontend/src/lib/engine/maiaWorkerHost.ts` | Empty. `WdlVector` (maiaEncoding.ts:94), `expectedScore`/`softmaxWdl` still present; `wdlByElo` transfer still present in `maiaWorkerHost.ts` (lines 57, 86, 237) |
| 4 | Instrumentation deliberately kept, script still runs | `maiaInferenceStats` (calibration-providers.mjs:127), per-`(fen,elo)` memo (`maiaRunMemo`, lines 142-193) present; `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-grading-depth-ab.mjs --help` | Exit 0, full docstring/usage printed, zero `wdl`/`WDL` hits left in that script (`grep -n "wdl\|Wdl\|WDL" scripts/engine-grading-depth-ab.mjs` → no matches) |
| 5 | Evidence trail intact | `ls` on each named path | `fixtures/engine/maia-blindness.tsv` (7738 bytes), `reports/leaf-wdl/{report.md 29914B, accept-rule.md 10350B, elo-conditioning.md 11061B}`, 5 TSVs in `reports/data/` (`engine-wdl-leaf-quality-*` x3, `engine-root-injection-*` x2), `docs/flawchess-engine-explained-2026-07-06.md` §2's "road not taken" paragraph present, `reports/root-injection/report.md`'s Phase 197 addendum (line 291+) present |
| 6 | SEED-128 honest about the strip | Read in full | Section retitled "What already exists (do not rebuild) — UPDATED after the operator ordered a full strip"; explicitly states the prior "retained... disabled" claim "became false," names the removal commits (`b1764a83`, plus per-artifact commits `7a8061ed`/`95bfb8ad`/`490b47a6`, `ea317466`/`c415a581`, `692d8e0d`/`55b82a6b`), and explicitly warns against overselling ("Do not oversell this as 'just a backup-logic change plus a re-run' — the code that re-run depended on is gone and must be rewritten first") |
| 7 | SUMMARYs carry visible post-plan corrections, not silent rewrites | Read `197-03-SUMMARY.md` and `197-04-SUMMARY.md` in full | Both open their body with a blockquoted `> **POST-PLAN CORRECTION**` note dated same-day, stating what changed and citing the strip commits, before the original (now-historical) plan narrative continues below it |
| 8 | REQUIREMENTS.md Coverage table matches reality | Read lines 143-159 | `LEAF-01 \| Phase 197 \| Rejected`; `LEAF-02/03/04/05/06/07 \| Phase 197 \| Complete`; explanatory note correctly states `WDL_LEAF_HANDOFF_DEPTH` is null (now: code is gone, not just null) and each Complete ID's evidence-based reasoning; points to SEED-128 and `reports/leaf-wdl/report.md` |

## Gates re-run (not trusted from SUMMARY claims)

| Gate | Command | Result |
|------|---------|--------|
| Type-check | `npx tsc -b` (frontend/) | Exit 0, no output |
| Frontend tests | `npm test -- --run` | 205 files / 2956 tests passed, 24.25s |
| Lint | `npm run lint` | 0 errors (3 pre-existing warnings in `frontend/coverage/*.js`, a generated coverage-report artifact unrelated to this phase or any source file) |
| Dead-export check | `npm run knip` | Exit 0, no findings |

## One residual documentation inconsistency (WARNING, not a blocker)

`.planning/REQUIREMENTS.md`'s `## v1 Requirements` checkbox list (lines 68-74) was **not** updated alongside the Coverage table fix in `d8847461`, and is now inverted relative to it:

| ID | Checkbox (line 68-74) | Coverage table (line 143-149) |
|----|------------------------|-------------------------------|
| LEAF-01 | `[x]` (looks satisfied) | `Rejected` |
| LEAF-02 | `[ ]` (looks incomplete) | `Complete` |
| LEAF-03 | `[x]` | `Complete` |
| LEAF-04 | `[ ]` | `Complete` |
| LEAF-05 | `[x]` | `Complete` |
| LEAF-06 | `[ ]` | `Complete` |
| LEAF-07 | `[ ]` | `Complete` |

The Coverage table is the accurate, load-bearing summary (it carries the explanatory note and matches the current codebase state). The top checkbox list is stale — it was last touched by Plan 01's completion commit and never reconciled after Plans 02-04 or the strip. A reader who only scans the checkbox list would get an inverted picture (thinking LEAF-01 shipped and LEAF-02/04/06/07 didn't happen at all). This is the same class of gap the prior verification flagged as a non-blocking WARNING; it persists, now with an added Coverage-table-vs-checklist contradiction within the same file. Recommended fix: either check `[x]` for LEAF-02..07 and add a footnote marker next to LEAF-01, or replace the raw checkboxes with the same status vocabulary the Coverage table now uses. Does not block this phase.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | The WDL-leaf mechanism, having been measured and rejected, is now fully removed from production code (not merely disabled) | ✓ VERIFIED | `frontend/` is byte-identical to pre-phase baseline (`git diff --stat 1f14f5de..HEAD -- frontend/` empty); zero mechanism symbols anywhere in `frontend/src/` or `scripts/` |
| 2 | LEAF-01 (SC1, "consumed as leaf value... reducing wall clock"): not true in production, by deliberate, evidence-based rejection | ✓ VERIFIED as correctly Rejected | REQUIREMENTS.md Coverage table marks `Rejected` with a clear explanatory note; matches codebase (mechanism absent) |
| 3 | LEAF-04 (SC1, other half): move quality was evaluated on its own terms, via a pre-declared instrument, before any acceptance decision | ✓ VERIFIED | `reports/leaf-wdl/accept-rule.md` predates the results it judges (`git log --diff-filter=A` timestamps unchanged from prior verification, re-confirmed); Gate A failed at handoff depths 2/3 on the Maia-blindness fixture (forced mate-in-3 missed), passed only by being behaviourally inert at depth 4 |
| 4 | LEAF-02: handoff depth choice was grounded in measurement against the Phase 195 post-ladder baseline | ✓ VERIFIED | `reports/leaf-wdl/report.md` (survives the strip, unmodified since prior verification) states 1.37x/2.00x baseline and per-depth sweep results |
| 5 | LEAF-03: frame invariant was verified (not assumed) while the mechanism existed, via a mirrored-not-identical fixture test | ✓ VERIFIED (historically satisfied; artifact now removed along with the rest of the mechanism) | `leafScore.test.ts`'s `wdlLeafExpectedScore` describe block existed and passed per prior verification's 88/88 read; both the function and its test were removed in `b1764a83` as part of the full strip — `leafScore.ts` now contains only the pre-existing `leafExpectedScore` (confirmed empty diff vs `1f14f5de`) |
| 6 | LEAF-05: ELO-conditioning question answered in writing as a design argument | ✓ VERIFIED | `reports/leaf-wdl/elo-conditioning.md` (153 lines, unmodified since prior verification) |
| 7 | LEAF-06: engine-explained doc §2 matches the shipped (rejected) design | ✓ VERIFIED | §2 still correctly states Stockfish is the sole quality axis (now unconditionally true again, not just "correctly true under rejection"), plus the "road not taken" paragraph naming Phase 197, the rejection, and pointing at the report + SEED-128 |
| 8 | LEAF-07: SEED-118's headline datum re-measured, shift attributed correctly, regression check performed with the mechanism disabled | ✓ VERIFIED | `reports/root-injection/report.md` Phase 197 addendum (134 lines, append-only, unmodified since prior verification) — confirms the injected move's score essentially unchanged and top-organic move within the reproducibility floor |

**Score:** 8/8 individual truths hold (mapping to the 7 LEAF- requirement IDs plus the meta-truth about the strip itself). All fully verified — no truths left unresolved, no human items outstanding.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `frontend/src/lib/engine/leafScore.ts` | Back to pre-phase Stockfish-only converter | ✓ VERIFIED | Empty diff vs `1f14f5de`; `wdlLeafExpectedScore` gone |
| `frontend/src/lib/engine/gradingLadder.ts` | Back to pre-phase state (no `WDL_LEAF_HANDOFF_DEPTH`/`usesWdlLeaf`) | ✓ VERIFIED | Covered by the empty `frontend/` diff; grep confirms zero hits |
| `frontend/src/lib/engine/types.ts` | Back to pre-phase state (no `EngineProviders.wdl?()`) | ✓ VERIFIED | Covered by empty `frontend/` diff |
| `frontend/src/lib/engine/maiaPolicyCache.ts` | Back to pre-phase state (no `getCachedWdl`) | ✓ VERIFIED | Covered by empty `frontend/` diff |
| `frontend/src/lib/maiaEncoding.ts` | Untouched — `WdlVector` predates Phase 197 | ✓ VERIFIED | Empty diff vs `1f14f5de`; `WdlVector`/`expectedScore`/`softmaxWdl` present |
| `frontend/src/lib/engine/maiaWorkerHost.ts` | Untouched — `wdlByElo` transfer predates Phase 197 | ✓ VERIFIED | Empty diff vs `1f14f5de`; `wdlByElo` present at 3 sites |
| `scripts/lib/calibration-providers.mjs` | WDL provider member removed; `maiaInferenceStats`/memo kept | ✓ VERIFIED | `nodeWdl`/`wdl` member gone (diff shows 111 lines removed in `7edb14da`); `maiaInferenceStats` (line 127) and per-`(fen,elo)` memo (lines 137-193) present and documented as intentionally kept for Phase 198 |
| `scripts/engine-grading-depth-ab.mjs` | WDL-leaf sweep arm removed, script still runnable | ✓ VERIFIED | Zero `wdl`/`WDL` references left; `--help` runs to completion, exit 0 |
| `scripts/engine-wdl-leaf-quality.mjs` | Deleted outright | ✓ VERIFIED | File absent; recoverable from named commits per SEED-128 |
| `fixtures/engine/maia-blindness.tsv` | Kept as evidence | ✓ VERIFIED | 7738 bytes, present, unmodified |
| `reports/leaf-wdl/{report,accept-rule,elo-conditioning}.md` | Kept as evidence | ✓ VERIFIED | All present, sizes match prior verification (unmodified) |
| `.planning/seeds/SEED-128-wdl-leaf-backup-reweighting.md` | Corrected to reflect the strip | ✓ VERIFIED | Section explicitly retitled and updated; names recovery commits; warns against overselling |
| `docs/flawchess-engine-explained-2026-07-06.md` §2 | Matches current (rejected, fully-removed) design | ✓ VERIFIED | Confirmed via grep; road-not-taken paragraph present |
| `reports/root-injection/report.md` Phase 197 addendum | Kept as evidence | ✓ VERIFIED | Present, unmodified since prior verification |
| `197-03-SUMMARY.md` / `197-04-SUMMARY.md` | Carry visible post-plan corrections | ✓ VERIFIED | Both open with a dated `POST-PLAN CORRECTION` blockquote before the original plan narrative |
| `.planning/REQUIREMENTS.md` | LEAF-01 Rejected, LEAF-02..07 Complete, explanatory note | ✓ VERIFIED (Coverage table) / ⚠️ stale checkbox list (see WARNING above) | Coverage table (lines 143-159) accurate; top checkbox list (lines 68-74) inverted/stale — non-blocking |

### Key Link Verification

Not applicable in the prior sense — the mechanism's wiring (provider → cache → runner branch) no longer exists to verify, by design. What remains wired and was re-confirmed:

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `maiaWorkerHost.ts` | analysis-board Maia ELO chart | `wdlByElo` transfer (pre-existing, Phase 194 CACHE-06 territory) | ✓ WIRED, untouched | Empty diff vs baseline confirms Phase 197 never altered this consumer |
| `scripts/lib/calibration-providers.mjs`'s `maiaInferenceStats`/memo | `engine-grading-depth-ab.mjs`'s non-WDL passes | Direct import/usage | ✓ WIRED | Script's `--help` run confirms no broken imports; instrumentation is documented as feeding Phase 198's planned `maia_cpu_ms` accumulator |

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|---|---|---|---|
| LEAF-01 | WDL head consumed as leaf value | **Rejected** — mechanism built, measured, removed | REQUIREMENTS.md line 143; codebase confirms removal |
| LEAF-02 | Handoff depth chosen from measurement | Complete | `reports/leaf-wdl/report.md` |
| LEAF-03 | Frame invariant verified before removal | Complete (verification occurred; artifact since removed with the rest) | Prior verification's direct test read; `leafScore.ts` now baseline |
| LEAF-04 | Move quality evaluated before acceptance | Complete — evaluation is what rejected the change | `reports/leaf-wdl/accept-rule.md` + report |
| LEAF-05 | ELO-conditioning answered in writing | Complete | `reports/leaf-wdl/elo-conditioning.md` |
| LEAF-06 | Engine doc matches shipped design | Complete | §2 + road-not-taken paragraph |
| LEAF-07 | SEED-118 datum re-validated | Complete | `reports/root-injection/report.md` addendum |

All 7 requirement IDs resolve cleanly under the "Rejected"/"Complete" vocabulary the operator's correction introduced. No orphaned requirements.

### Anti-Patterns Found

None new. Re-scanned all files touched across the strip commits (`b1764a83`, `7edb14da`, `608aa6af`) for `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` — zero hits. No `.skip`/`.todo` in `frontend/src/lib/engine/__tests__/`.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Mechanism symbols absent | `grep -rn "wdlLeafExpectedScore\|WDL_LEAF_HANDOFF_DEPTH\|usesWdlLeaf\|wdlLeafHandoffDepth\|getCachedWdl\|makeWdlGatedProviders" frontend/src/ scripts/` | No matches | ✓ PASS |
| Frontend byte-identical to pre-phase | `git diff --stat 1f14f5de..HEAD -- frontend/` | Empty | ✓ PASS |
| Pre-existing WDL infra untouched | `git diff 1f14f5de..HEAD -- frontend/src/lib/maiaEncoding.ts frontend/src/lib/engine/maiaWorkerHost.ts` | Empty | ✓ PASS |
| Depth-AB script loads and runs post-strip | `node --import ./scripts/lib/frontend-alias-hook.mjs scripts/engine-grading-depth-ab.mjs --help` | Exit 0, full usage printed | ✓ PASS |
| No stray WDL references in depth-AB script | `grep -n "wdl\|Wdl\|WDL" scripts/engine-grading-depth-ab.mjs` | No matches | ✓ PASS |
| Type-check clean | `npx tsc -b` | Exit 0 | ✓ PASS |
| Frontend test suite green | `npm test -- --run` | 205 files / 2956 tests passed | ✓ PASS |
| Lint clean (source) | `npm run lint` | 0 errors | ✓ PASS |
| Knip clean | `npm run knip` | 0 findings | ✓ PASS |

### Probe Execution

Not applicable — no `scripts/*/tests/probe-*.sh` convention for this phase (unchanged from prior verification).

### Human Verification Required

None. The single item escalated by the prior verification is resolved: the operator confirmed and then superseded the "disabled but retained" disposition with a stronger one (full removal), which I independently verified actually happened in the codebase rather than accepting on narrative. No new ambiguity was introduced by the strip that requires a further human decision.

### Gaps Summary

No blocking gaps. One non-blocking WARNING carried forward and slightly sharpened: `.planning/REQUIREMENTS.md`'s top-of-file checkbox list (lines 68-74) was never reconciled with the Coverage table fix in `d8847461`, and is now inverted (LEAF-01 checked despite being Rejected; LEAF-02/04/06/07 unchecked despite being Complete). The Coverage table itself is accurate and carries a correct explanatory note. Recommend a small maintenance edit to the checkbox list; does not block phase closure or downstream Phase 198/199 work.

---

*Verified: 2026-07-31*
*Verifier: Claude (gsd-verifier)*
