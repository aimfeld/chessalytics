# Phase 211 Context — Vetted "Also Fine" Moves & Server-Key Grading

**Source:** `/gsd-explore` session 2026-08-16 (user + assistant), distilled into
[SEED-150](../../seeds/SEED-150-vetted-also-fine-moves.md). This file records the USER
DECISIONS from that session; the seed carries the full verified analysis. Both were
verified against the tree on 2026-08-16.

## Problem (observed in prod)

A Train puzzle showed "Bxf4 also fine"; free-play graded Bxf4 good; the source game's
analysis board correctly grades Bxf4 a blunder (rapid 10+5 vs shenova, Jul 31 2026;
Bxf4 was NOT the game move). Root cause is structural, not eval noise: the "Also fine"
list comes from ranks 2–4 of a 1.5s MultiPV-4 client search (node budget split 4 ways)
while the server's deep guarantee covers only the top-2 (`missed_pv_lines` node 0:
`b`/`bm`/`s`/`sm`/`su`) or the herring MultiPV-5 ladder. Ranks 3–4 are never vetted;
even client rank 2 can be a different move than the server's `su`.

## Locked Decisions (user-approved 2026-08-16)

- **D-01 — Vetted-only display.** The "Also fine" list (legend row + board arrows,
  desktop AND mobile) shows only server-vetted moves: soft puzzle → at most the deep
  second-best (`su`; the Phase 205 dead band already certifies it *good*, gap <
  INACCURACY_DROP); sharp puzzle → none, always; red herring → only `herring_pool.ladder`
  moves whose ES gap vs rank 1 is in the good band (shared sigmoid, white-POV cp/mate
  per D-16 of Phase 192).
  - **Amendment (user-approved 2026-08-16, Task 3 checkpoint round 2):** soft puzzles now
    serve the deep BEST move too — vetted list = [best (quality `best`), second-best],
    best-first, display-filtered client-side as before. Rationale: with the `su` alone, a
    soft puzzle whose `su` coincided with the client's best/played move rendered an empty
    "Also fine" row under the "several fine moves" copy; serving the deep best guarantees
    the copy is backed by at least one displayable alternative, or by both fine moves
    already being on screen as the best/played arrows. D-04 untouched: no blob/worker
    change — the best UCI comes from the already-stored `game_positions.best_move` at the
    flaw ply, degrading to su-only when NULL/unavailable. D-07 consequence: a played deep
    best matches the certified key and records tier `good` (the score ladder has no best
    tier) with a drop-0 graded-ES pair.
- **D-02 — Post-attempt delivery, P-01 held.** POOL-10 / P-01 (LOCKED, `app/schemas/train.py`)
  stays byte-identical: no answer-key material on the pre-attempt `TrainPuzzle` payload.
  Vetted moves + their evals reach the client only after the attempt is recorded
  (solve-recording POST response, or an attempt-gated fetch — planner's choice).
- **D-03 — Server-key grading for key moves.** Playing a vetted move is graded from the
  server's deep evals: BOTH esBefore and esAfter from the blob/ladder through the shared
  sigmoid (`lib/liveFlaw`), no engine search. Verdict can therefore never contradict the
  "Also fine" list.
- **D-04 — Off-key grading stays live-engine (ACCEPTED RESIDUAL).** A played move outside
  the vetted set is graded by the existing full-budget width-1 after-move search
  (same-engine ES delta vs client rank 1). This can still disagree with the analysis
  board's deeper verdict. The user explicitly accepted this residual; the top-K deep-eval
  blob extension (worker-pipeline change) is OUT OF SCOPE — do not creep it in.
- **D-05 — Mount search drops to width 1.** `TRAIN_GRADING_MULTIPV_WIDTH` 4 → 1;
  `deriveFineMoves` and the rank-match fast path (190.1 UAT round 9) are retired; the
  full 1.5s budget concentrates on the main line (deeper esBefore + solution PV).
  Precondition: trace all remaining consumers of the `lines` array passed through
  `GradeResult` (the Phase 200 reveal exploration surface passes it around) before removal.
- **D-06 — Phase 205 guarantee re-established, not regressed.** Phase 205 (ORACLE-0x)
  graded the free-play root ply from the mount search's rank lines — that mechanism dies
  with width 4. Its guarantee ("an Also fine move can never be badged a mistake when
  played") must hold the new way: list and root-ply grading both read the same server
  key. Deeper free-play plies stay engine-only, as today.

- **D-07 — P-02 narrowed, not violated (user-approved 2026-08-16, post-research).** The
  client still asserts `move_quality` in every `SolveRequest` (no request schema change;
  P-01 intact). When `played_move` matches the certified key (soft `su`, or a qualifying
  herring ladder entry), `record_solve` recomputes `move_quality`/`correct_move` from the
  server's stored evals via the existing expected-score helpers and OVERRIDES the client's
  assertion — the same shape as the existing `_compute_correct_guess` override. The solve
  response carries the graded eval numbers so the board-displayed `playedMoveQuality`
  re-classifies from the same data (display and recorded verdict can never diverge).
  Off-key moves keep pure P-02 behavior (D-04). P-02's docstrings in
  `app/schemas/train.py` (`SolveRequest`/`RecordedSolve`) MUST be amended in the same
  change — the "backend never grades the move" sentence must not survive unqualified.

## Constraints

- Requirements to be minted at planning time (this phase predates its milestone's
  REQUIREMENTS.md — same convention as Phases 206–210); one per Success Criterion in the
  ROADMAP entry, suggested prefix `VETFINE-`.
- Never re-derive the sigmoid/thresholds locally — `@/lib/liveFlaw` client-side,
  `app/services/flaws_service.py` server-side (CI-drift-checked pair).
- Mobile parity per CLAUDE.md: any legend/arrow change applies to both desktop and mobile
  reveal surfaces.
- `trainRevealCache` (see `frontend/src/lib/__tests__/trainRevealCache.test.ts`) persists
  `fineMoves` — cached-shape migration/compat must be considered.

## Key code touchpoints (verified 2026-08-16)

- `frontend/src/hooks/useTrainGradingEngine.ts` — `deriveFineMoves` (~l.293), rank-match
  fast path (~l.749), `TRAIN_GRADING_MULTIPV_WIDTH` (~l.96), `clampLineEvalToBest`
- `frontend/src/components/train/TrainReveal.tsx` — "Also fine" row + spotlight key
- `frontend/src/lib/trainArrows.ts` — `TrainFineMove`, arrow derivation
- `app/services/train_pool.py` — `dead_band_admissible`, `classify_puzzle_type`
- `app/services/forcing_line_gate.py` — `PvNode` blob shape
- `app/models/herring_pool.py` — ladder shape + POV/`mover_color` conventions
- `app/routers/train.py` / `app/schemas/train.py` — solve-recording endpoint + P-01 lock
