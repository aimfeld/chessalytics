---
phase: 206-train-warmup-sharp-filler
verified: 2026-08-07T13:52:53Z
status: passed
score: 8/8 must-haves verified
behavior_unverified: 0
overrides_applied: 1
human_verification:

  - test: "With the dev clock and scripts/reset_train_state.py --user-id N, clear SR material and open /train. Confirm the warm-up banner's visual weight/tone read correctly, the title/body render as designed, and 'Next review: {date}' appears only when a next due date exists."
    expected: "A Card with Dumbbell icon, 'Warm-up session' title, and the D-09 body copy renders between TrainHeader and the CTA; the 'Next review' clause is present only when next_due_date is non-null."
    why_human: "Copy tone and visual weight are explicitly flagged as judgement calls in 206-VALIDATION.md's Manual-Only Verifications table — not automatable."

  - test: "Solve a full all-filler (warm-up) session end to end in the real app."
    expected: "The sharp reveal shows check/cross, the client-computed best line, and the motif name, with no game footer and no Analyze deep-link (D-20)."
    why_human: "The reveal's minimal-plus-motif treatment is a design/feel judgement, flagged manual-only in 206-VALIDATION.md."

  - test: "Solve roughly 15 sharp positions from app/data/sharp_filler_puzzles.csv via the real UI."
    expected: "The positions read as unambiguous warm-up tactics (not benchmark-grade or ambiguous), consistent with D-12's 1000-1400 band and D-13's Stockfish-verified sharpness."
    why_human: "Whether the deck 'feels' like warm-up material is an operator call, flagged manual-only in 206-VALIDATION.md."
---

# Phase 206: Train Warm-Up Sessions & Sharp Filler Pool Verification Report

**Phase Goal:** A Train session that contains none of the user's own analyzed blunders stops
silently masquerading as a normal session. When the SR side is empty, the user gets an
explicitly labeled warm-up built from an honest mix of sharp static puzzles and several-fine-
moves red herrings — not a full deck of herrings whose critical/several answer is always
"several". The same static sharp set becomes the co-filler for *any* SR shortfall, so no
session's critical/several base rate is skewed by the backfill.

**Verified:** 2026-08-07
**Status:** passed
**Re-verification:** No — initial verification

> Status moved `human_needed` → `passed` on 2026-08-07 after `/gsd-verify-work 206` recorded
> all three manual items as pass (`206-UAT.md`, 3 passed / 0 issues). One issue was raised and
> resolved during that session — `G-206-1`, the warm-up banner body copy, split by cause in
> commit `7df627e82` and re-confirmed. Security gate cleared separately: `206-SECURITY.md`,
> `threats_open: 0`.

## Goal Achievement

### Observable Truths (the 8 ROADMAP Success Criteria, WARM-01..WARM-08)

| # | Truth (Success Criterion) | Status | Evidence |
|---|---|---|---|
| 1 | WARM-01: A user whose composed session contains zero `SR_ITEM` puzzles sees an explicitly labeled warm-up, surviving resume across the ES lottery | VERIFIED | `train_repository.py:1900-1908` derives `is_warmup = len(surviving_sr_keys) == 0`, frozen onto `DrillSession.is_warmup` (`:1935`) and read (never recomputed) in `_resume_session` (`:1332`). Reverted the resume-read line to `is_warmup=False` — `test_is_warmup_survives_resume_after_material_arrives` and `test_no_resume_recomputation_mutation_check` both went RED, confirmed and restored. `TrainSessionResponse.is_warmup` round-trips over HTTP (`test_session_response_exposes_is_warmup`, verified passing). Frontend `resolveLandingState` (`TrainStartScreen.tsx:146-148`) renders the `'warmup'` kind from the server boolean only, and carries `isWarmup` on `'resume'` too so the banner survives a partial solve. |
| 2 | WARM-02: A user with ≥1 qualifying blunder sees an ordinary unlabeled session; label never derived from session ordinal | VERIFIED | Discriminant is a plain `== 0` equality against `surviving_sr_keys`, never a ratio/threshold/session-count. Reverted the discriminant to `< 2` — `test_one_sr_item_is_not_warmup` went RED, confirmed and restored. Grepped the added lines: no reference to session ordinal, session count, `session_date`, or account age anywhere in the derivation. |
| 3 | WARM-03: A warm-up session's critical/several answer is genuinely mixed (never all-several, never all-critical) | VERIFIED | `_select_candidates` caps `herring_candidates` at `herring_slots = floor(n * HERRING_SHARE)` and never grows it (the pre-206 cross-backfill arm that pulled extra herrings is retired, `train_repository.py:1587-1595`). `_backfill_sharp_fillers` fills every residual shortfall from the static (Stockfish-verified-sharp) set. Ran `test_zero_sr_material_composes_two_herrings_and_six_sharp` and `test_three_sr_candidates_compose_three_sr_two_herring_three_sharp` directly — both pass, confirming an 8-puzzle all-filler session is exactly 2 herring + 6 sharp, never 8 herring. |
| 4 | WARM-04: No warm-up/filler puzzle ever produces a `drill_items` row, and no static sharp puzzle can acquire SR state | VERIFIED | The `DrillItem(...)` insert loop iterates only `new_sr_items` (SR-pool picks), never sharp-filler picks — structurally, a `SHARP_FILLER` puzzle is never a candidate for that loop. `sharp_puzzle_id` carries no relationship to `drill_items`' PK `(user_id, game_id, ply)` with `game_id` FK to `games.id`. Ran `test_solve_sharp_filler_touches_no_drill_item` and `test_reveal_sharp_filler_reports_sharp_filler_source` directly — both pass. |
| 5 | WARM-05: `pool_eligible_since` is stamped for filler-only sessions, proven by a test that goes red when the widened condition is reverted | VERIFIED | `train_repository.py:1781`: `has_material=has_drill_items or has_pool_candidates or sharp_filler_available()`. Reverted the third term — `test_filler_only_session_stamps_pool_eligible_since` went RED (confirmed directly: `assert None == datetime.date(...)` failure), confirmed and restored. |
| 6 | WARM-06: The `puzzle_type !== 'herring'` proxy replaced by a `source`-based predicate at ALL sites together (`TrainReveal.tsx:874`, `:915-917`, `:925`, `:1266`) | VERIFIED | All three live predicate sites read `verdict.source === 'sr_item'` (`TrainReveal.tsx:879-880` the mastery-banner gate, `:936` the `guessFeedbackProse` third argument, `:1290` the game-footer gate). Grepped the whole frontend tree for `puzzle_type !== 'herring'` — zero remaining code references (only explanatory comments naming the old proxy for context). Backend: `_wire_source` (`train_repository.py:2013-2038`) is the single, exhaustive `DrillSource`->wire-string mapping, raising `ValueError` on an unrecognized member; used by both `record_solve` and `reveal_for_puzzle`. Ran the full `TrainReveal`/`TrainStartScreen` Vitest suites directly — 128 tests pass, including the sharp_filler-suppresses / sr_item-with-puzzle_type-sharp-still-renders pair that specifically proves the predicate reads `source`, not `puzzle_type`. |
| 7 | WARM-07: The static sharp set has a stable no-repeat-until-exhausted ordering mirroring `herring_stmt`'s contract, sized for several days | VERIFIED (see WARNING below) | `app/data/sharp_filler_puzzles.csv` verified directly: 208 rows, 13 motifs × 16 each, ratings 1000-1400 (checked via direct Python import). `SHARP_SET` is a total order sorted ascending by `puzzle_id`, loaded once at import (`sharp_filler.py:103-104`). `pick_sharp_fillers` filters to unserved, falls back to the full set only when the unserved list is *literally empty* — a faithful mirror of `herring_stmt`'s all-or-nothing exhaustion contract, exactly as D-14 specifies. Directly reproduced a boundary case (206 of 208 served, `limit=6`) and confirmed only 2 puzzles are returned rather than 6 — this is WR-02 from `206-REVIEW.md`, a real (if narrow) gap between the phase's own "a session is always full" framing (F-03, the stated justification for removing the `'short'` landing state) and the mirrored-from-herring_stmt implementation. See Anti-Patterns/Gaps below for full assessment — not a blocker, but a documented tension worth a decision. |
| 8 | WARM-08: Each production change is mutation-tested (revert -> confirm test goes red) rather than accepted on symbol presence | VERIFIED | Independently reproduced 3 of the phase's named mutation checks myself (not merely trusting the SUMMARY): (1) `_resume_session`'s `is_warmup=drill_session.is_warmup` -> `is_warmup=False` turned both resume tests RED; (2) the `is_warmup` discriminant `== 0` -> `< 2` turned `test_one_sr_item_is_not_warmup` RED; (3) the `has_material` widening reverted turned `test_filler_only_session_stamps_pool_eligible_since` RED. All three restored cleanly (`git diff --stat` empty afterward). SUMMARY.md and REVIEW.md both document additional mutation checks (D-13 sharpness gate, D-12 mate-theme exclusion, the frontend banner-gate and Next-review-clause checks) that were not independently re-run here but are consistent with the phase's demonstrated discipline. |

**Score:** 8/8 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `app/services/sharp_filler.py` | `SharpPuzzle`, `SHARP_SET`/`SHARP_SET_BY_ID`, `pick_sharp_fillers`, `served_sharp_ids_stmt`, `sharp_filler_available`, fail-closed loader | VERIFIED | Read in full. Loader raises `RuntimeError` on missing/empty file (`:76-98`); mirrors `opening_lookup.py`'s module-constant pattern. |
| `app/data/sharp_filler_puzzles.csv` | 200+ Stockfish-verified CC0 positions, 13 motifs balanced | VERIFIED | 208 rows confirmed by direct import; 13 motifs at exactly 16 each; ratings all within [1000,1400] (per plan 02's own committed test suite, spot-checked via direct query). |
| `app/models/drill_solve.py` | `DrillSource.SHARP_FILLER=2`, `sharp_puzzle_id`, widened CHECK | VERIFIED | Read in full — matches D-10/D-17 exactly. |
| `app/models/drill_session.py` | `is_warmup` Boolean NOT NULL, `server_default="false"` | VERIFIED | Read in full — matches D-07. |
| `alembic/versions/*_phase_206_sharp_filler_source.py` | One migration, all three schema changes, clean up/down | VERIFIED | Read in full; `alembic heads` shows single head `e5f71b11fa51`; upgrade/downgrade bodies are the exact inverse of each other. |
| `scripts/gen_sharp_filler_set.py` | One-off authoring script, no app import, no `--db` flag | VERIFIED | `grep -rn "^from\|^import" app/ | grep -c gen_sharp_filler` returns 0 (re-confirmed). Contains `passes_sharpness_gate`, `assign_primary_motif`, `TARGET_MOTIFS`, `MOTIF_LABELS`, `PER_MOTIF_CAP`. |
| `frontend/.../TrainReveal.tsx` | `source`-based predicate at 3 sites, motif row | VERIFIED | Read in full — matches D-19/D-20. |
| `frontend/.../TrainStartScreen.tsx` | `'warmup'` kind replacing `'short'`, banner markup | VERIFIED | Read in full — `'short'` fully removed, `'warmup'` added, `TrainEmptyBody` untouched as D-16 requires. |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `train_repository.py` (`_backfill_sharp_fillers`) | `sharp_filler.py` (`pick_sharp_fillers`) | post-reconstruction shortfall backfill | WIRED | Confirmed by reading `:1626-1686` and the boundary-case reproduction above. |
| `train_repository.py` (`load_session_puzzles`/`reveal_for_puzzle`) | `sharp_filler.py` (`SHARP_SET_BY_ID`) | in-memory FEN/motif lookup, no SQL join | WIRED | Confirmed at `reveal_for_puzzle:2708-2712`, `:2748-2749`, `:2772-2781`. |
| `train.py` schemas/router | `_wire_source` | single mapping site for `SolveResponse.source`/`PuzzleRevealResponse.source` | WIRED | Confirmed `_wire_source` is called from both `record_solve` and `reveal_for_puzzle`; schema fields present in `app/schemas/train.py:164,209`. |
| `TrainReveal.tsx` | `frontend/src/types/train.ts` | `verdict.source === 'sr_item'` at all 3 predicate sites | WIRED | Confirmed via direct grep — no remaining `puzzle_type !== 'herring'` in executable code. |
| `train_repository.py` (`_stamp_pool_eligibility` call site) | `sharp_filler.py` (`sharp_filler_available`) | widened `has_material` term | WIRED | Confirmed at `:1781`; mutation-reverted and confirmed RED as documented above. |
| `TrainStartScreen.tsx` (`resolveLandingState`) | `frontend/src/types/train.ts` (`TrainSessionResponse.is_warmup`) | single equality, no client arithmetic | WIRED | Confirmed at `:146-148`. |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| WARM-01 | 206-03 | Explicitly labeled warm-up, survives resume | SATISFIED | See Truth #1 above. |
| WARM-02 | 206-03 | Ordinary session with ≥1 blunder, never ordinal-derived | SATISFIED | See Truth #2 above. |
| WARM-03 | 206-01 | Genuinely mixed critical/several answer | SATISFIED | See Truth #3 above. |
| WARM-04 | 206-01 | No `drill_items` row, no SR state for filler | SATISFIED | See Truth #4 above. |
| WARM-05 | 206-03 | `pool_eligible_since` stamped, mutation-tested | SATISFIED | See Truth #5 above. |
| WARM-06 | 206-01 | `source`-based predicate at all sites | SATISFIED | See Truth #6 above. |
| WARM-07 | 206-01 (contract), 206-02 (sizing) | Stable no-repeat ordering, sized for several days | SATISFIED (with documented boundary gap, WR-02) | See Truth #7 above. |
| WARM-08 | 206-01/02/03 | Every production change mutation-tested | SATISFIED | See Truth #8 above. |

Per the task brief, Phase 206 predates its milestone's `.planning/REQUIREMENTS.md` — the eight
IDs above are minted in `206-01-PLAN.md`'s own traceability table and are not expected to
appear in `.planning/REQUIREMENTS.md`. This is not reported as an orphaned-requirement gap.

### Anti-Patterns / Known Gaps (from 206-REVIEW.md, independently re-verified)

None are BLOCKERs. All four were found by the phase's own code review and independently
confirmed here by reading the cited code (and, for WR-02, by direct reproduction):

- **WR-01** (`train_repository.py:2282-2289`): `_mark_session_complete_if_done`'s SHARP_FILLER
  leniency clause checks only `sharp_puzzle_id IS NOT NULL`, not that the id still resolves in
  `SHARP_SET_BY_ID` — unlike the herring clause, which outer-joins and checks row existence
  (the SEED-123 fix). Confirmed present in the current code. Reachable only if a future CSV edit
  violates the append-only contract while a session referencing the removed id is in flight — no
  test currently guards this case. WARNING, not a blocker under the phase's actual shipped state
  (append-only is honored today).

- **WR-02** (`sharp_filler.py:153-155`): `pick_sharp_fillers` under-fills (returns fewer than
  `limit`) whenever `0 < len(unserved) < limit`, not only when `unserved` is empty. Independently
  reproduced: with 206/208 puzzles served and `limit=6`, only 2 are returned. This directly
  tensions with F-03's "a session is always full" framing that justified removing the `'short'`
  landing state (D-16) — F-03 is not universally true, only true until the last `n-1` puzzles
  before a full-set repeat cycle. The failure mode is benign (a smaller-than-requested
  `puzzle_count` renders correctly via the surviving `'warmup'`/`'fresh'` states with no crash or
  stuck session — confirmed by reading `resolveLandingState`, which uses `session.puzzle_count`
  as-is) but is a real, provable gap between the documented design invariant and the shipped
  behavior. It mirrors `herring_stmt`'s own accepted all-or-nothing exhaustion shape exactly (a
  precedent from Phase 192), so this is a known, deliberate-by-mirroring tradeoff, not a bug
  unique to this phase. Recommend a developer decision: either accept and correct F-03's wording,
  or widen `pick_sharp_fillers`' fallback (option (b) in `206-REVIEW.md`).

- **WR-03** (`sharp_filler.py:90`): `side_to_move` parsing silently coerces any value other than
  `"white"` to `"black"` instead of validating, at odds with the loader's own documented
  fail-closed contract for every other field. Confirmed present. No current data-integrity risk
  (the committed file's own test class catches a mismatch), but no defense-in-depth against a
  future manual edit.

- **WR-04** (`scripts/gen_sharp_filler_set.py:494-532`... actually `:525-532`): `_write_csv` runs
  before the per-motif shortfall check, so a failed re-run of this one-off (but documented as
  safe-to-re-run) script would first overwrite the good committed file, then exit non-zero.
  Confirmed present by reading the code. Not shipped/scheduled infrastructure, so lower bar, but
  a genuine one-line-reorder bug a future maintainer could hit.

None of the four affect the phase's actual shipped state (the currently-committed 208-row file
is append-only-honored, fully within cap, and every `side_to_move` value is valid) — they are
latent risks in future re-runs or edits, not present defects in what ships today.

### Human Verification Required

Three items are explicitly flagged manual-only in `206-VALIDATION.md`'s own "Manual-Only
Verifications" table (visual/tone/feel judgement calls, not assertions) and in
`206-03-SUMMARY.md`'s `human_judgment: true` coverage item — see the frontmatter
`human_verification` list above for the full test/expected/why-human breakdown:

1. Warm-up banner visual weight and copy tone in the real app (dev clock + `reset_train_state.py`).
2. Sharp-puzzle solve/reveal "feel" (minimal-plus-motif treatment) across a full all-filler session.
3. Whether ~15 sampled sharp positions read as unambiguous warm-up tactics rather than benchmarks.

### Gaps Summary

No BLOCKER gaps. All 8 ROADMAP Success Criteria (WARM-01..WARM-08) are verified against the
actual codebase, not SUMMARY claims — I read every cited file directly, ran the relevant test
suites myself, and independently reproduced three of the phase's own mutation checks plus the
WR-02 boundary condition. The four code-review WARNINGs (WR-01..WR-04) are real, confirmed by
direct code inspection, and none of them break the phase's actual shipped behavior — they are
latent risks under specific future conditions (a CSV edit violating append-only, near-total pool
exhaustion, a malformed manual data edit, or a failed script re-run without checking exit code).
WR-02 specifically means the phase's own "a session is always full" narrative (used to justify
removing the `'short'` landing state) is not literally true at the boundary — this is worth a
developer decision (accept the narrative correction, or widen the fallback) but does not block
the phase, since the actual failure mode self-heals and degrades gracefully per the code I read.

Status is `human_needed` rather than `passed` solely because of the three manual-only visual/feel
verifications the phase's own validation plan already scoped out of automated coverage — every
other item is fully verified.

---

## Acknowledged Gate Overrides

### OV-01 — `api-coverage.verify-pre` (blocking, `verify:pre`)

**Gate result:** `block: true` — "external-API integration detected without a coverage matrix.
Produce COVERAGE.md enumerating the API surface … before sealing."

**Override:** applied by the developer on 2026-08-07, at `/gsd-verify-work 206`, before UAT began.

**Justification — the gate is a false positive on this phase:**

1. The detector substring-matched the literal phrase `external API integration` inside the
   sentence *"No external API integration: static committed CC0 puzzle data, no runtime service
   calls."* — present verbatim in all three PLAN files (`206-01-PLAN.md:690`,
   `206-02-PLAN.md:427`, `206-03-PLAN.md:355`). It matched a negation as an affirmation.

2. The phase adds zero network calls. `git diff dba203111..HEAD -- app/ scripts/ frontend/src/`
   contains no added `httpx`, `aiohttp`, `requests`, `urllib`, `fetch(`, `axios`, or URL literal.
   Direct grep of every phase-touched source file (`app/services/sharp_filler.py`,
   `scripts/gen_sharp_filler_set.py`, `app/repositories/train_repository.py`,
   `app/routers/train.py`) returns 0 network references each.

3. Every import added by the phase is stdlib, `python-chess`, SQLAlchemy, `sentry_sdk`, or an
   in-repo `app.*` module.

4. The only external-origin data is `app/data/sharp_filler_puzzles.csv`, a copy of already-vendored
   CC0 fixture rows. D-11 exists specifically to guarantee it is never read from a runtime path,
   and that guarantee is verified above.

**Scope:** this override applies to phase 206 only. The gate remains enabled
(`workflow.api_coverage_gate: true`) and is genuinely satisfied by the `COVERAGE.md` files in
phases 189, 191, 195, 201, and 202, which do integrate external APIs. No rule file, detector, or
config value was modified.

---

_Verified: 2026-08-07_
_Verifier: Claude (gsd-verifier)_
