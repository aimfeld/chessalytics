# SEED-145 Stage B census — repaired Stockfish arm

Only the Stockfish arm changed. Maia and FlawChess read `row.fen` directly, so all their ledgered values were already correct and no engine was re-run.

## The repair

`game_positions.eval_cp` has two populations with **opposite** ply conventions. lichess %evals are post-move, so the eval of the sampler's `fen[P]` sits on row P-1. Entry-lane evals (`eval_entry.py`) snapshot the board pre-push, evaluate that position, and write it at the same ply — already aligned.

Measured with a fresh Stockfish at depth 16 on `fen[P]`, 150 rows per population: entry-lane sits **7.0 cp** from `eval_cp[P]` (aligned); lichess sits **26.5 cp** from `eval_cp[P]` but **13.0 cp** from `eval_cp[P-1]` (shifted).

Stage B headline basis is **103,097** rows: **33,574** lichess-sourced (repaired) and **69,523** entry-lane (left untouched). A blanket ply-1 shift would have corrupted the larger share.

## Brier — raw

| boundary | n | SF | Maia | FC | Blend50 |
|---|---|---|---|---|---|
| middlegame | 63,953 | 0.2110 | 0.2090 | 0.2102 | **0.2079** |
| endgame | 39,144 | 0.1350 | 0.1364 | 0.1358 | **0.1332** |

### Paired ΔBrier — raw

Negative ⇒ the first arm is better. |z| >= 1.96 is p < 0.05.

| boundary | pair | ΔBrier | z | verdict |
|---|---|---|---|---|
| middlegame | FC − SF | -0.00074 | -3.59 | **FC** wins (p<0.05) |
| middlegame | FC − Maia | +0.00124 | +3.92 | **Maia** wins (p<0.05) |
| middlegame | FC − Blend50 | +0.00236 | +11.31 | **Blend50** wins (p<0.05) |
| middlegame | SF − Maia | +0.00199 | +5.91 | **Maia** wins (p<0.05) |
| endgame | FC − SF | +0.00073 | +2.50 | **SF** wins (p<0.05) |
| endgame | FC − Maia | -0.00063 | -1.46 | n.s. |
| endgame | FC − Blend50 | +0.00260 | +8.71 | **Blend50** wins (p<0.05) |
| endgame | SF − Maia | -0.00136 | -3.21 | **SF** wins (p<0.05) |

## Brier — isotonic-recalibrated (cross-fitted)

| boundary | n | SF | Maia | FC | Blend50 |
|---|---|---|---|---|---|
| middlegame | 63,953 | 0.2097 | 0.2091 | 0.2097 | **0.2079** |
| endgame | 39,144 | 0.1353 | 0.1365 | 0.1357 | **0.1335** |

### Paired ΔBrier — isotonic-recalibrated (cross-fitted)

Negative ⇒ the first arm is better. |z| >= 1.96 is p < 0.05.

| boundary | pair | ΔBrier | z | verdict |
|---|---|---|---|---|
| middlegame | FC − SF | +0.00007 | +0.38 | n.s. |
| middlegame | FC − Maia | +0.00067 | +2.31 | **Maia** wins (p<0.05) |
| middlegame | FC − Blend50 | +0.00189 | +9.75 | **Blend50** wins (p<0.05) |
| middlegame | SF − Maia | +0.00060 | +2.15 | **Maia** wins (p<0.05) |
| endgame | FC − SF | +0.00039 | +1.26 | n.s. |
| endgame | FC − Maia | -0.00084 | -1.91 | n.s. |
| endgame | FC − Blend50 | +0.00218 | +6.88 | **Blend50** wins (p<0.05) |
| endgame | SF − Maia | -0.00124 | -2.89 | **SF** wins (p<0.05) |

## What the repair moved

Stockfish's Brier before and after, split by provenance. The entry-lane rows are identical by construction — they are the control.

| boundary | population | n | SF repaired | SF as-published | delta |
|---|---|---|---|---|---|
| middlegame | lichess (repaired) | 20,345 | 0.2072 | 0.2051 | +0.0021 |
| middlegame | entry-lane (control) | 43,608 | 0.2128 | 0.2128 | +0.0000 |
| endgame | lichess (repaired) | 13,229 | 0.1305 | 0.1261 | +0.0044 |
| endgame | entry-lane (control) | 25,915 | 0.1373 | 0.1373 | +0.0000 |
