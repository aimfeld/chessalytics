---
phase: 192-red-herring-position-pool
plan: 03
subsystem: api
tags: [postgresql, sqlalchemy, stockfish, chess-engine, train, herring-pool, measurement]

# Dependency graph
requires:
  - phase: 192-01
    provides: herring_pool table + HerringPool model, EnginePool.evaluate_nodes_multipv5, the tracer generator this plan completes
  - phase: 192-02
    provides: drill_solves.game_id nullable + ON DELETE SET NULL (unrelated to this plan's scope, but the just-completed sibling)
provides:
  - "scripts/gen_red_herring_pool.py — complete generator: phase-balanced thirds (D-19), bounded oversampling, keyset two-pass random-start scan, resumable top-up (D-14), --measure mode, Rollout docstring (D-11/D-13/D-14)"
  - "app/services/train_pool.py — HERRING_LOOSE_BAND_ES confirmed at 0.10 from measured data (no longer provisional); new HERRING_DEGENERATE_MIN_GAP_ES=0.02 (D-17) pinned from the same measurement, for Plan 04's query-time gate to consume"
  - "tests/scripts/test_gen_red_herring_pool.py — 6 new selection/persistence-logic tests"
  - "dev herring_pool populated: 30 real rows (10 per phase), generated end to end against dev with real Stockfish"
affects: [192-04-query-time-gate, 192-05-reveal-frontend]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Two-pass random-start keyset scan (user_id >= start, then user_id < start) — covers a candidate frame exactly once regardless of where the random start lands, without OFFSET"
    - "Resumable top-up via ON CONFLICT DO NOTHING + per-INSERT rowcount check — a re-scan re-encountering an already-stored row does not falsely count toward a bucket's shortfall"
    - "Measurement mode as a variant code path (_evaluate_candidate(measure=True)) sharing the exact same reconstruct/reject/search logic as generation, differing only in whether the loose-band gate is applied — guarantees the measured distribution matches what generation would have seen"

key-files:
  created:
    - tests/scripts/test_gen_red_herring_pool.py
  modified:
    - scripts/gen_red_herring_pool.py
    - app/services/train_pool.py
    - tests/services/test_train_pool.py

key-decisions:
  - "HERRING_LOOSE_BAND_ES (D-15) CONFIRMED at 0.10, not moved — measured data across 298-300 dev candidates per phase shows 83.3-94.0% already qualify at that band, comfortably 2x the 0.05 tight gate, with only marginal (~1-5pp) gain from loosening to 0.15"
  - "HERRING_DEGENERATE_MIN_GAP_ES (D-17) pinned at 0.02, a new constant — trims the bottom 17-29% flat/no-real-decision tail per phase without cutting into the 71-83% genuine several-fine-moves body; one bucket tighter (0.01) under-trims, one bucket looser (0.03) cuts too deep"
  - "Measurement (Task 2) used a separate ad hoc scratchpad script (not committed) with a plain ORDER BY random() sample and a concurrent EnginePool dispatch (asyncio.gather over search calls only, never the DB session) purely for wall-clock speed on a one-off dev-only data-gathering run — the SHIPPED --measure mode in gen_red_herring_pool.py still uses the real keyset/random-start scan and stays single-worker, matching the generator's production design"
  - "Ambient-state-proof test design: every generator test monkeypatches fen_and_last_move_at_ply to a per-ply lookup (unknown plies silently 'unreconstructable') and reads _existing_count for real to compute headroom, so tests are deterministic regardless of other test files' leftover game_positions/herring_pool rows in the shared per-worker test DB"

requirements-completed: [POOL-03]

coverage:
  - id: D1
    description: "Generator is complete: phase-balanced thirds (D-19) with independent per-bucket shortfall, bounded oversampling, resumable top-up (ON CONFLICT DO NOTHING + rowcount check so a re-run only inserts the shortfall), guest-excluded frame (D-02), keyset two-pass scan (never OFFSET), and a Rollout docstring covering D-11/D-13/D-14"
    requirement: "POOL-03"
    verification:
      - kind: unit
        ref: "tests/scripts/test_gen_red_herring_pool.py (all 6 tests)"
        status: pass
      - kind: integration
        ref: "uv run python scripts/gen_red_herring_pool.py --db dev --n-positions 30 (real run: 25 stored, 10/10/10 across phases, 0 guest rows), then an identical re-run (0 new rows stored)"
        status: pass
    human_judgment: false
  - id: D2
    description: "HERRING_LOOSE_BAND_ES confirmed and HERRING_DEGENERATE_MIN_GAP_ES pinned from a real ~900-candidate MultiPV-5 measurement, basis recorded in-comment and in this SUMMARY; no denormalized expected-score column added"
    requirement: "POOL-03"
    verification:
      - kind: unit
        ref: "tests/services/test_train_pool.py::test_loose_band_exceeds_tight_gate"
        status: pass
      - kind: unit
        ref: "tests/services/test_train_pool.py::test_degenerate_min_gap_is_a_real_positive_discriminator"
        status: pass
      - kind: other
        ref: "Programmatic + manual spot-check of 30 real dev herring_pool rows against the pinned constants (see Quality Spot-Check below)"
        status: pass
    human_judgment: false

duration: ~70min
completed: 2026-07-28
status: complete
---

# Phase 192 Plan 3: Generator completion + measured D-15/D-17 constants Summary

**The red-herring pool generator is now the tool the phase ships — phase-balanced thirds, bounded oversampling, resumable top-up, a `--measure` mode — and both deliberately-deferred qualifier constants (`HERRING_LOOSE_BAND_ES` confirmed at 0.10, new `HERRING_DEGENERATE_MIN_GAP_ES` pinned at 0.02) are set from a real ~900-candidate MultiPV-5 measurement against dev, not guessed.**

## Performance

- **Duration:** ~70 min
- **Tasks:** 2 (Task 1: generator completion, Task 2: measurement + constant pinning)
- **Files modified:** 4 (1 created, 3 modified)

## Accomplishments

- **Generator completed** (`scripts/gen_red_herring_pool.py`): `--phase` is now optional — when omitted, `--n-positions` splits into phase-balanced thirds (D-19) with the remainder going to the opening bucket, and each bucket's shortfall (`target - existing`) is computed and scanned independently so one bucket never absorbs another's quota.
- **Keyset two-pass random-start scan**: candidates are paged via `(user_id, game_id, ply) > cursor` keyset pagination (never `OFFSET`), starting from a random `user_id` and covering the full range in two passes (`>= start`, then `< start`) so a re-run's random start doesn't just re-scan (and re-reject) the same low-`user_id` positions every time.
- **Resumable top-up (D-14)**: `ON CONFLICT (user_id, game_id, ply) DO NOTHING`, with the per-`INSERT` rowcount checked so a conflict (an already-stored row re-encountered by chance) does NOT falsely count toward a bucket's shortfall — a re-run genuinely only inserts what's missing.
- **`--measure` mode** added (Task 2 instrumentation, shipped in the script): scans up to `--n-positions` SEARCHED candidates per phase, applying every reject EXCEPT the loose-band gate, and logs PV0-PV1/PV0-PV4 expected-score gap histograms. Shares `_evaluate_candidate` with generation, so the measured distribution is exactly what generation would see.
- **Rollout docstring section** covering D-11 (local Stockfish, never the prod server, never a background tier), D-13 (deploy source swap first; record the empty-pool window's timestamps), and D-14 (one-shot, manual top-up, no cron).
- **Verified end to end against dev**: `--db dev --n-positions 30` stored 25 new rows (10/10/10 across all three phases, existing middlegame count of 5 carried over from Plan 01's tracer smoke test); zero guest-sourced rows (`SELECT count(*) FROM herring_pool hp JOIN users u ON u.id=hp.user_id WHERE u.is_guest` → 0); an identical re-run stored 0 new rows (idempotent).
- **Measured the D-15/D-17 qualifier constants** from 298-300 real MultiPV-5-searched dev candidates per phase (~900 total searches, full histograms below) and pinned both in `app/services/train_pool.py` with the basis recorded in-comment.
- Full backend suite green: 3869 passed / 27 skipped (`uv run pytest -n auto`); `ruff format`/`ruff check`/`ty check` all clean.

## Task Commits

Each task was committed atomically:

1. **Task 1: Complete the generator — phase thirds, oversampling, resumable top-up, runbook** — `7b05f1ba` (feat)
2. **Task 2: Measure the qualifying-rate distribution and pin the two deferred constants** — `8833cb43` (feat)

**Plan metadata:** pending (this commit)

## Measurement Details (Task 2)

**Method:** a separate, uncommitted scratchpad script reused the shipped module's exact decision functions (`expected_score_for`, `_build_ladder`, `_bucket_index`, `mover_color_for_ply`, `fen_and_last_move_at_ply`, the D-02/D-18 filters) but sampled via a plain `ORDER BY random() LIMIT n` (acceptable for a one-off dev-only data-gathering run — the shipped `--measure` CLI mode uses the real keyset/random-start scan) and dispatched the MultiPV-5 searches concurrently via `asyncio.gather` over a 10-worker `EnginePool` (never over the DB session) purely for wall-clock speed. Total run: ~13 minutes for 898 real searches (298 opening + 300 middlegame + 300 endgame).

### Per-phase candidate counts

| Phase | Random candidates drawn | Survived legal-move/ply-parity pre-filter | Successfully searched |
|---|---|---|---|
| opening | 1800 | 300 | 298 |
| middlegame | 1800 | 300 | 300 |
| endgame | 1800 | 300 | 300 |

(2 opening candidates failed the MultiPV-5 search/ladder-build step — an occasional engine timeout/failure, same class of rejection the shipped generator counts under "engine failure".)

### PV0-to-PV1 expected-score gap (the D-15 loose-band decision variable) — cumulative %

| Cumulative gap ≤ | opening | middlegame | endgame |
|---|---|---|---|
| 0.01 | 50.3% | 48.0% | 46.0% |
| 0.02 | 66.8% | 63.7% | 59.0% |
| 0.03 | 77.5% | 72.0% | 62.3% |
| 0.05 | 87.6% | 84.0% | 72.0% |
| **0.10** | **94.0%** | **93.0%** | **83.3%** |
| 0.15 | 95.3% | 95.7% | 87.7% |

**Decision:** `HERRING_LOOSE_BAND_ES` **confirmed at 0.10** (the D-15 anchor, not moved). At 0.10, 83.3-94.0% of real searched candidates per phase already clear the band (i.e., already have `HERRING_MIN_QUALIFYING_MOVES=2` satisfied by PV0+PV1 alone) — comfortably 2x above the 0.05 query-time tight gate (`INACCURACY_DROP`), and loosening further to 0.15 buys only 1.4-4.4 additional points per phase. 0.10 is not leaving a meaningful slice of real several-fine-moves positions unstored.

### PV0-to-PV4 expected-score gap (the new D-17 degenerate-exclusion decision variable) — cumulative %

| Cumulative gap ≤ | opening | middlegame | endgame |
|---|---|---|---|
| 0.01 | 5.7% | 5.0% | 18.3% |
| **0.02** | **24.8%** | **17.0%** | **29.0%** |
| 0.03 | 40.3% | 30.3% | 38.0% |
| 0.05 | 62.1% | 53.0% | 48.7% |
| 0.10 | 78.2% | 75.7% | 66.3% |

**Decision:** `HERRING_DEGENERATE_MIN_GAP_ES` **pinned at 0.02** (new constant, consumed at query time by Plan 04). At 0.02, 17.0-29.0% of searched candidates per phase are excluded — the genuinely flat, "every legal move about equally fine" tail. One bucket down (0.01) only trims 5.0-18.3% (too thin a cut, especially opening/middlegame, where the density peaks just above zero rather than at it). One bucket up (0.03) starts cutting 30.3-40.3% — deep enough into the body of genuine several-fine-moves positions to risk under-serving. 0.02 sits at the point where the trim is meaningful across all three phases without yet eating into the bulk of the distribution.

## Quality Spot-Check (Task 2, 192-VALIDATION.md § Manual-Only Verifications)

Sampled 10 stored dev `herring_pool` rows at random and replayed each FEN + ladder by hand; separately ran a programmatic check over all 30 dev rows (qualifying-count under `HERRING_LOOSE_BAND_ES` + whether each would clear the new `HERRING_DEGENERATE_MIN_GAP_ES` floor).

**Outcome:** all 10 manually-reviewed rows read as genuine several-fine-moves positions — clustered top-of-ladder evaluations with plausible alternative moves (e.g. row id=25: Bxe7/Bd6/Bc5 all within 0.06 ES before Bf8/Nh4 fall off; row id=1: three roughly-equal ways to convert a winning position; row id=21: two genuinely fine knight recaptures with castling revealed as a tactical trap several ranks below). The programmatic check over all 30 rows confirms every stored row has `qualifying >= 2` as required, and shows 6 of the 30 (20%, in line with the measured 17-29% range) would be excluded at serve time by the new `HERRING_DEGENERATE_MIN_GAP_ES=0.02` floor — exactly the flat/no-real-decision positions D-17 exists to catch (e.g. row id=33: all 5 ladder entries at the identical cp).

**One row did not perfectly match expectations:** row id=24's raw MultiPV-5 ladder has PV[1] (cp=-9) very slightly BETTER for white than the declared PV[0] (cp=-15) — a ~6cp / ~0.005 ES non-monotonic rank artifact. This is a known real-world quirk of node-budget-limited (rather than depth-limited) MultiPV search, not a bug in the generator: the script stores Stockfish's own MultiPV output verbatim, best-first as returned. The tiny inversion is harmless here — it doesn't affect the qualifying-count decision (a negative gap trivially clears any positive band) — but is recorded here per the "any row that did not [match]" instruction.

## Files Created/Modified

- `scripts/gen_red_herring_pool.py` — completed: optional `--phase` (thirds split via `_thirds_split`), keyset two-pass random-start scan (`_candidate_frame_stmt`, `_user_id_bounds`, `_random_start_passes`, `_scan_pass`, `_scan_bucket`), resumable top-up (`_existing_count`, `_write_candidate`'s rowcount check), `--measure` mode (`run_measurement`, `_measure_bucket`, `_GapHistograms`, `_log_histogram`), Rollout docstring section
- `app/services/train_pool.py` — `HERRING_LOOSE_BAND_ES` comment rewritten with the measured basis (value unchanged, PROVISIONAL marker removed); new `HERRING_DEGENERATE_MIN_GAP_ES: float = 0.02` with its measured basis
- `tests/scripts/test_gen_red_herring_pool.py` — new file, 6 tests: `test_generator_rejects_fewer_than_five_legal_moves`, `test_generator_loose_gate_boundary`, `test_generator_rerun_tops_up_without_duplicates`, `test_generator_splits_n_into_phase_thirds`, `test_generator_excludes_guest_sourced_positions`, `test_generator_dry_run_writes_nothing`
- `tests/services/test_train_pool.py` — two new tests: `test_loose_band_exceeds_tight_gate`, `test_degenerate_min_gap_is_a_real_positive_discriminator`

## Decisions Made

- **`HERRING_LOOSE_BAND_ES` confirmed at 0.10** rather than moved — the measured data shows it already admits 83-94% of real candidates, so there was no data-driven reason to loosen it, and loosening would only shrink the retunability headroom above `INACCURACY_DROP`.
- **`HERRING_DEGENERATE_MIN_GAP_ES` (new constant) pinned at 0.02** — chosen as the bucket that trims a meaningful degenerate tail (17-29%) across all three phases without cutting materially into the genuine several-fine-moves body, per the measured cumulative distribution table above.
- **Measurement tooling kept out of the committed script** — the ad hoc `ORDER BY random()` + concurrent-`EnginePool` measurement runner used to gather Task 2's data lives only in the session scratchpad, not in `scripts/`; the shipped `--measure` CLI mode reuses the production keyset/random-start scan and stays single-worker, matching D-11/D-14's design (no new concurrency surface introduced into the tool that will eventually run against prod).
- **Duplicate-vs-shortfall accounting via `INSERT` rowcount, not a pre-check**: `_write_candidate` returns whether a row was ACTUALLY inserted (rowcount > 0), so an ON CONFLICT no-op never gets miscounted as progress toward a bucket's target — this is what makes the idempotency proof exact rather than approximate.

## Deviations from Plan

None — plan executed exactly as written. Both tasks' acceptance criteria were met without needing a Rule 1-4 deviation.

## Issues Encountered

- The Task 2 measurement's "several hundred searched candidates per phase" requirement, run sequentially at the shipped generator's single-worker pace, would have taken on the order of 30-45 minutes based on the Task 1 real-run rate (~2s/candidate). Since this is a one-off, uncommitted, dev-only data-gathering step (not the shipped tool's runtime behavior), it was run via a separate scratchpad script with a 10-worker concurrent `EnginePool` dispatch instead, completing in ~13 minutes for 898 real searches. This does not change the shipped script's single-worker design (see Decisions Made).

## User Setup Required

None — no external service configuration required. The dev PostgreSQL container and a local Stockfish binary were the only runtime dependencies, both already in place from Plan 01.

## Next Phase Readiness

- The generator is the tool the phase ships: idempotent, resumable, phase-balanced, guest-free, with a runbook covering the D-11/D-13/D-14 prod rollout. Dev's `herring_pool` now holds 30 real rows (10 per phase) generated end to end with real Stockfish, ready for Plan 04/05 to build and test against without needing to re-run the generator.
- Both deferred constants (`HERRING_LOOSE_BAND_ES`, `HERRING_DEGENERATE_MIN_GAP_ES`) carry measured values with recorded bases — Plan 04's query-time gate can consume `HERRING_DEGENERATE_MIN_GAP_ES` directly; no further measurement work is needed.
- **Note for Plan 04:** the nine skipped `herring_stmt` tests in `tests/services/test_train_pool.py` remain untouched (Plan 01's named debt handoff, unaffected by this plan) — still Plan 04's job to replace with the tight query-time gate (`INACCURACY_DROP` + the new `HERRING_DEGENERATE_MIN_GAP_ES` floor) tests.
- **No D-13 empty-pool window applies to this plan** — that timestamp-recording requirement is for the real prod rollout (a future deploy step), not this dev-only measurement/generation work.

## Self-Check: PASSED

- `FOUND: scripts/gen_red_herring_pool.py`
- `FOUND: tests/scripts/test_gen_red_herring_pool.py`
- `FOUND: app/services/train_pool.py` (modified)
- `FOUND: tests/services/test_train_pool.py` (modified)
- `FOUND: 7b05f1ba` (git log)
- `FOUND: 8833cb43` (git log)

---
*Phase: 192-red-herring-position-pool*
*Completed: 2026-07-28*
