# SEED-137 — Train's guess label, move score, and free-play badges come from three different searches

**Captured:** 2026-08-04, from two contradictions user 28 hit in prod drill session 107.
**Status:** promoted to Phase 205 (Train Grading Oracle Agreement) on 2026-08-04
**Trigger:** any milestone touching Train grading, the drill pool, or the reveal surface.

## What was observed

Session 107 (user 28), both items `source = 0` (SR own-blunder), `herring_pool_id IS NULL`:

| pos | game/ply | played | guess | correct_guess | correct_move | quality |
|-----|----------|--------|-------|---------------|--------------|---------|
| 0 | 2050740 / 34 | `c3d1` (Nd1) | several | ✗ | **✓** | inaccuracy |
| 4 | 2050738 / 30 | `h5h6` (h6) | several | ✓ | ✗ | wrong |

1. Puzzle labelled **"One move is clearly better than the alternatives"**, yet the played
   Nd1 earned +1 and rendered a green check.
2. Puzzle labelled **"Several moves are fine here… Also fine: Qh4"**, yet playing Qh4 on
   the reveal board badged it a mistake.

**Not a herring-sourcing artifact.** Both are `source = 0`. The pre-Phase-192
`game_best_moves` herring problem is unrelated to either — ruled out from the data, not
from the code.

## Root cause: three independent evaluators, one set of thresholds

| # | Evaluator | Decides |
|---|-----------|---------|
| 1 | Server answer key (`game_flaws.missed_pv_lines` node 0) | sharp/soft → the **guess** verdict |
| 2 | Browser mount search (Stockfish WASM, MultiPV-**4**, 1500 ms, `useTrainGradingEngine`) | **move tier**, "Best move", the "Also fine" list |
| 3 | Browser free-play engine (separate Worker, MultiPV-**2**, 1500 ms, `useStockfishEngine` via `useTrainFreePlay`) | move-quality **badges** while exploring |

All three measure the same `INACCURACY_DROP` / `MISTAKE_DROP` / `BLUNDER_DROP` cutoffs
(0.05 / 0.10 / 0.15 ES) with different search budgets. Any position whose true gap sits
within search noise of a cutoff produces a visible self-contradiction.

**Case 1 (evaluator 1 vs 2).** Blob node 0: `b = -72`, `s = -226`, `su = "c3d1"` — gap
**0.131 ES** ≥ `MISTAKE_DROP` → sharp, correctly, and the user played *exactly the
second-best move the blob prices as a mistake*. The browser read `-80 / -190` → gap
**0.095** → `inaccuracy` → `correct_move = true`, and `toDisplayQuality` collapses
inaccuracy→good, so it renders a green check. A 0.005 ES difference flipped it. The
server already held that move's exact price and it was discarded.

**Case 2 (evaluator 2 vs 3).** Blob node 0: `b = 481`, `s = 310`, `su = "g3h4"` — gap
**0.0968**, soft by 0.0032. "Also fine: Qh4" comes from evaluator 2's mount ranks; the
mistake badge comes from evaluator 3 re-searching the post-Qh4 position. Neither consults
the blob. **No threshold value fixes this one** — it is browser-vs-browser.

## Prevalence (prod, 2026-08-04)

- 2,431,033 blunder answer keys; **25.1% sharp**, and **5.6% sit within ±0.025 ES of the
  0.10 boundary** — the measured browser search-noise tolerance (`ES_STABILITY_TOLERANCE`).
- Of 87 solves on server-sharp puzzles, **4 already scored a point for a
  browser-measured inaccuracy** (4.6%) — case 1's exact shape.
- **15% of all SR solves play exactly `su`**, the one wrong move whose price the server
  already knows.

## Proposal A — selection-level dead band

Keep `SHARP_GAP_ES = MISTAKE_DROP` (it is an identity, not a knob: "several fine moves is
correct" *means* "a second move would score a point", and scoring means drop <
`MISTAKE_DROP` — decoupling the label cutoff from the scorer cutoff manufactures a
contradiction band exactly as wide as the decoupling). Instead, **filter the pool**:

- **sharp items:** second-best drop ≥ `BLUNDER_DROP` (0.15) — every alternative is a
  blunder. Node 0 stores only the second-best move, but that is exactly the right column:
  second-best is by definition the best alternative, so the single comparison is total.
- **soft items:** second-best drop < `INACCURACY_DROP` (0.05) — a second genuinely good
  move exists.
- **excluded:** everything in `[0.05, 0.15)`.

Cost (prod): **12.0% of items dropped** (20.4% kept sharp, 67.6% kept soft). Sharp share
after: 23.2% vs 25.1% today, so the guess base rate barely moves and does not become more
gameable. Viability at the binding constraint — distinct games per user, since
`MAX_ITEMS_PER_GAME_PER_SESSION = 1` means a 12-puzzle session needs ≥9 distinct games:
of 260 users, **219 can fill a session today, 218 after — one user newly starved**, average
89.7% of distinct games retained.

Effect: on a kept-sharp item every alternative is ≥0.15 below best, so any non-best move
scoring a point requires a **≥0.05 ES browser error** (2× the noise envelope) instead of
the ~0.005 that flipped Nd1. Symmetric buffer on the soft side for rank 2.

**Implementation edge:** filtering in `pool_entry_stmt` stops only *new* entries —
existing `drill_items` rows for band plies keep being served. The check must also run at
composition time, via the existing lazy-eviction path (serve-time reads already LEFT JOIN
`game_flaws` and tolerate a missing match, per `drill_item.py`'s D-02 anchoring note). A
reclassification backfill can move an item into or out of the band after the fact, so the
gate has to be live at compose time, never snapshotted onto the row (D-01 already forbids
snapshotting grading-critical fields).

## Proposal B — seed free play with the mount ranks

`useTrainFreePlay` receives `seedEval` as only `{cp, mate, bestUci}` for the root
position; the grading engine's settled `lines` array is discarded. So the first freely
played move is graded against a *fresh* MultiPV-2 search of the post-move position rather
than the mount rank that put it on the "Also fine" list.

Fix: pass the whole `lines` array and short-circuit the first ply's grade to the matching
rank — exactly what `gradeMoveInner`'s `rankLineForMove` branch already does for the solve
verdict. Deeper plies stay engine-3-only, which is self-consistent (parent and child from
the same engine), so the cross-oracle seam exists only at the root — which is the one
place users notice it ("Also fine: X" → play X → mistake).

Small, local, independent of Proposal A, and it is the bug actually reported. Do it first.

## Residual inconsistencies neither proposal closes

1. **Evaluator 2's internal seam.** A played move outside the top-4 mount ranks is graded
   by a width-1 after-move search while `fineMoves` came from the MultiPV-4 mount.
   `clampLineEvalToBest` reconciles the *display* but not the verdict. Mostly harmless
   after Proposal A (such a move is ≥0.15 down on a sharp item). Widening MultiPV would
   close it; probably not worth the budget.
2. **The server cannot name its own best move.** Node 0 keys are `b/bm/s/sm/su` — there is
   no best-move UCI. "Best move: Qc1" is *always* evaluator 2's rank 1, never the answer
   key's, and on a sharp item the two can name different moves with nothing able to detect
   it. Server-authoritative sharp puzzles would need a `bu` key — an eval-pipeline change,
   not a Train change. Open question in its own right.
3. **Soft items: the label is verified, the list is not.** The band guarantees rank 2 is a
   good move; ranks 3–4 in the "Also fine" row are evaluator-2-only and could genuinely be
   mistakes. Either cap the displayed list at what the server verified, or accept it as
   browser-grade — decide deliberately rather than inherit.
4. **`[[SEED-130]]` applies directly.** The browser never clears the Stockfish TT, so
   evaluator 2's reading of a position depends on what that worker slot searched before
   (up to 241 cp / 0.0135 ES mean at depth 14 in this project's own grading-ladder data).
   This is *why* Proposal A's buffer wants to be 0.05 rather than 0.025.

## Rejected along the way

**Raising `SHARP_GAP_ES` from `MISTAKE_DROP` to `BLUNDER_DROP`** (i.e. relabelling rather
than filtering). It does not constrain the pool at all — `classify_puzzle_type` is a
classifier, never an entry gate (P-04) — and it does not make puzzles easier, since the
same positions are served. But it converts case 1 into case 2: the `[0.10, 0.15)` band
(**4.7% of all items**) would be labelled "several moves are fine here" while our own
scorer gives their runner-up zero points — no measurement error required, guaranteed every
time. It also pushes the guess base rate to 79.6/20.4, making "always answer several" a
larger freebie. The dead band above is the version of this instinct that works.

## Related

- Phase 189 (`pool_entry_stmt`, `classify_puzzle_type`), Phase 190/190.1
  (`useTrainGradingEngine`), Phase 192 (`herring_pool` — ruled out here), Phase 200
  (`useTrainFreePlay`).
- `[[SEED-130]]` — uncleared browser Stockfish hash; same family, different surface.
- `[[project_eval_nondeterminism]]` — dev-vs-prod eval nondeterminism.
