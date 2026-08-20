---
id: SEED-150
status: active
planted: 2026-08-16
planted_during: /gsd-explore after a real puzzle showed "Bxf4 also fine" while the analysis
  board graded the same move a blunder (rapid 10+5 vs shenova, Jul 31 2026 source game)
trigger_when: next Train-focused phase or milestone, or sooner if another user-visible
  "also fine vs blunder" contradiction is reported
scope: medium — one backend delivery surface (post-attempt payload), client reveal/grading
  rewiring in useTrainGradingEngine + TrainReveal/trainArrows, retire deriveFineMoves and
  the rank-match fast path, drop TRAIN_GRADING_MULTIPV_WIDTH 4 → 1. No new engine work,
  no blob/worker pipeline change, no migration.
supersedes: nothing — builds on Phase 205's dead band (SEED-137) and Phase 192's herring
  ladder; the 191-UAT mistake-rank exclusion in deriveFineMoves becomes moot
---

# SEED-150: Limit "Also fine" to server-vetted moves; grade key moves from server evals

## Problem

The Train reveal's "Also fine" list is derived client-side (`deriveFineMoves` in
`../../../frontend/src/hooks/useTrainGradingEngine.ts`) from ranks 2–4 of a 1.5s MultiPV-4
WASM mount search. But the server's deep-analysis guarantee only ever covers the
**top two** moves:

- Flaw-derived puzzles: the `missed_pv_lines` node-0 blob stores exactly best
  (`b`/`bm`) and second-best (`s`/`sm`/`su`) — see `PvNode` in
  `../../../app/services/forcing_line_gate.py`.
- So client ranks 3–4 are **never deep-vetted**, and even the client's rank 2 can
  be a different move than the server's `su`.

Worse, MultiPV-4 splits the node budget four ways, so each rank is searched even
shallower than 1.5s suggests — worst conditions for spotting a tactical
refutation, on positions that are *selected* to be sharp/tactical. Observed
user-facing contradiction: hint says "Bxf4 also fine", free-play grades it good,
the analysis board (whose `useLiveMoveFlaw` engine searches unbounded while you
sit on the position) correctly calls it a blunder. All three surfaces behaved as
designed; the design lets a never-vetted move be advertised as "fine".

Secondary inconsistency fixed for free: on **sharp** puzzles the runner-up is a
certified blunder (Phase 205 dead band, gap ≥ BLUNDER_DROP), so the honest
"Also fine" list is *empty* — yet today the shallow client search can still draw
a fine-move arrow there.

## What the server can certify (verified 2026-08-16)

- **Soft puzzles: exactly one vetted alternative** — the blob's `su`. The dead
  band guarantees its ES gap < INACCURACY_DROP, i.e. certified *good* (not
  merely "not a mistake").
- **Sharp puzzles: zero alternatives** by construction.
- **Red herrings: up to four** — `herring_pool.ladder` is a full MultiPV-5 deep
  ladder (5 moves, white-POV cp/mate, best-first; generation guarantees
  ≥ HERRING_MIN_QUALIFYING_MOVES = 2 in the good band). Serve every ladder move
  whose ES gap vs rank 1 lands in the good band, via the shared sigmoid.

## Design

1. **Delivery: post-attempt only.** POOL-10 / P-01 (LOCKED) forbids answer-key
   fields on the *pre-attempt* `TrainPuzzle` payload (`../../../app/schemas/train.py`
   docstring). "Also fine" renders at reveal time, after the attempt — deliver
   the vetted list (and the key moves' evals) in the solve-recording POST
   response, or a post-attempt fetch gated on a recorded attempt. This does NOT
   reopen P-01; the lock is on the pre-attempt surface.
2. **Client display:** the "Also fine" list / arrows (`TrainReveal`,
   `trainArrows`) render only the server-vetted moves. Sharp → empty, soft → at
   most one, herring → good-band ladder moves.
3. **Grading, two internally consistent regimes:**
   - **Played move in the server key** (soft `su`, or a herring ladder move):
     grade from the server's deep evals — BOTH esBefore and esAfter from the
     blob/ladder through the shared sigmoid. Verdict agrees with the Also-fine
     list by construction, needs **no search at all** (instant, replaces a
     shallow rank eval with deep truth).
   - **Played move off-key:** existing full-budget width-1 after-move search;
     severity = same-engine client delta (esBefore from client rank 1). This is
     *deeper* than the current budget-split rank-match eval it replaces.
4. **Drop `TRAIN_GRADING_MULTIPV_WIDTH` 4 → 1.** Remaining mount-search
   consumers need only rank 1: exact-match fast path, esBefore, solution-line
   PV. Width 1 concentrates the full 1.5s budget on the main line (deeper
   esBefore + displayed solution). Retire `deriveFineMoves` and the rank-match
   fast path (190.1 UAT round 9); most of `clampLineEvalToBest` / the
   rank-inversion bug class evaporates.
   - **Verify first:** trace remaining consumers of the `lines` array passed
     through `GradeResult` (reveal exploration surface passes it around) before
     removing width 4.

## Cost / accepted residuals

- A non-best, off-key played move now always incurs the second 1.5s "Checking
  your move…" search (previously a rank-2–4 hit skipped it). That population is
  mostly wrong moves; vetted alternatives become instant. Net latency likely
  improves.
- **Accepted residual (user decision 2026-08-16):** grading of off-key played
  moves stays best-effort live-engine — a "good ✓" there can still contradict
  the analysis board's deeper verdict. Eliminating that would need top-K deep
  evals in the flaw blob (worker-pipeline change) — explicitly NOT in scope; do
  not creep it in.
- We never *advertise* unvetted moves; that is the promise this seed restores.

## Pointers

- `../../../frontend/src/hooks/useTrainGradingEngine.ts` — deriveFineMoves (l.293),
  rank-match fast path (l.749), width constant (l.96), 191-UAT comment on the
  ~7% borderline disagreement this seed's root cause also explains
- `../../../app/services/train_pool.py` — dead band (`dead_band_admissible`),
  `classify_puzzle_type`, SEED-141 gate
- `../../../app/services/forcing_line_gate.py` — `PvNode` blob shape
- `../../../app/models/herring_pool.py` — ladder shape + POV convention
- `../../../app/schemas/train.py` — P-01 lock on the pre-attempt payload
