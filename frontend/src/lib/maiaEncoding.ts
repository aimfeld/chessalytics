/**
 * maiaEncoding.ts — original MIT glue for the Maia-3 ("Chessformer") ONNX model:
 * board->tensor encoding, legal-move policy masking + softmax, expected-score, and
 * the ELO-ladder input mechanism (MAIA-03).
 *
 * This module is NOT derived from CSSLab's AGPL-licensed reference client source
 * (`maia-platform-frontend`'s `MaiaEngineContext`/encoding utilities). It is written
 * from scratch against the CONFIRMED tensor contract recorded in
 * `.planning/phases/151-maia-in-the-browser-all-position-surfaces/151-MAIA-CONTRACT.md`,
 * which was produced by loading the real `maia3_simplified.onnx` and inspecting its
 * declared I/O + running real inference (Plan 151-01). See that file for the full
 * evidence trail; the load-bearing facts are summarized in the comments below.
 */

import { Chess } from 'chess.js';

// ─── Board encoding constants (CONTRACT §a) ────────────────────────────────────

/** 8x8 board, one token per square. */
export const NUM_SQUARES = 64;

/** 12 one-hot piece-occupancy planes per square (no history — n=0, "simplified" export). */
export const PLANES_PER_SQUARE = 12;

/**
 * Confirmed 12-plane order (CONTRACT §a): white P,N,B,R,Q,K (indices 0-5),
 * black p,n,b,r,q,k (indices 6-11).
 */
const PIECE_PLANE_ORDER = ['P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k'] as const;

// ─── ELO ladder (CONTRACT §c; range widened per UAT quick 260705-bm3) ────────────

/**
 * Lower bound of the ELO ladder. maiachess.com presents the full 600–2600 human
 * range, so we match it (UAT quick 260705-bm3). NOTE: Plan 151-01 behaviorally
 * validated the model only across 1100–2000 (monotonically rising draw-rate sweep);
 * 600–1000 are extrapolation BELOW that validated band — kept because Maia-3 takes a
 * continuous ELO input and maiachess.com itself displays this range.
 */
const MAIA_ELO_LADDER_MIN = 600;

/**
 * Upper bound of the ELO ladder. See MIN: 2100–2600 are extrapolation ABOVE the
 * 151-01-validated 1100–2000 band, matching maiachess.com's displayed range.
 */
const MAIA_ELO_LADDER_MAX = 2600;

/** Step size between rungs — named per CLAUDE.md "no magic numbers". */
const MAIA_ELO_LADDER_STEP = 100;

/**
 * The ELO ladder: 600..2600 in steps of 100 (21 rungs), matching maiachess.com's
 * presented range (UAT quick 260705-bm3). The behaviorally-validated sub-band is
 * 1100..2000 (151-MAIA-CONTRACT.md §c / Plan 151-01); the ends are extrapolation.
 */
export const MAIA_ELO_LADDER: readonly number[] = Array.from(
  { length: (MAIA_ELO_LADDER_MAX - MAIA_ELO_LADDER_MIN) / MAIA_ELO_LADDER_STEP + 1 },
  (_, i) => MAIA_ELO_LADDER_MIN + i * MAIA_ELO_LADDER_STEP,
);

// ─── Policy vocabulary (CONTRACT §d) ────────────────────────────────────────────

/** Total flat policy-logit vocabulary size, confirmed by real inference (CONTRACT §d). */
export const POLICY_VOCAB_SIZE = 4352;

/** Base (non-underpromotion) move-index space: every (from, to) square pair. */
const BASE_VOCAB_SIZE = NUM_SQUARES * NUM_SQUARES; // 4096

/**
 * Underpromotion piece lanes reserved per destination square. 4352 - 4096 = 256 =
 * 64 destination squares x 4 piece lanes — this is the only integer decomposition
 * of the confirmed vocab size that cleanly separates "every from->to pair" (queen
 * promotions collapse into the base lane, since a pawn reaching the back rank always
 * promotes and 'to' alone disambiguates it from a non-promoting move) from "explicit
 * underpromotion, keyed by destination + piece only" (origin is unambiguous from
 * board state: exactly one pawn can reach a given back-rank square in one move).
 *
 * ASSUMPTION (flagged, not silently guessed): the CONTRACT confirms the vocab SIZE
 * (4352) and the general key scheme ("from+to+promotion"), but not CSSLab's literal
 * index ORDER for `all_moves_maia3.json` — reconstructing their exact enumeration
 * order without copying their AGPL data file is the phase's acknowledged open risk
 * (151-MAIA-CONTRACT.md §d: "Wave 2 must ship our own vocabulary/index table").
 * This scheme is deterministic and internally consistent (round-trips correctly
 * inside this module), but its alignment with the REAL model's index order is
 * unverified until VALID-01's real-ONNX cross-check (Plan 151-06) — see
 * 151-04-SUMMARY.md "Known Limitations" for the explicit follow-up.
 */
const UNDERPROMOTION_PIECE_LANES = ['q', 'r', 'b', 'n'] as const;
type PromotionPiece = (typeof UNDERPROMOTION_PIECE_LANES)[number];

// ─── Types ──────────────────────────────────────────────────────────────────────

/** WDL probability vector (post-softmax), in the natural W/D/L reading order. */
export interface WdlVector {
  win: number;
  draw: number;
  loss: number;
}

// ─── Square indexing (CONTRACT §a) ──────────────────────────────────────────────

/**
 * Maps an algebraic square (e.g. "e4") to the CONTRACT's confirmed token index:
 * `s = row*8 + file`, `row = rank - 1` (a1 = 0, h8 = 63).
 */
export function squareIndex(square: string): number {
  const file = square.charCodeAt(0) - 'a'.charCodeAt(0);
  const rank = Number(square[1]);
  const row = rank - 1;
  return row * NUM_SQUARES_PER_SIDE + file;
}

/** Board is 8x8 — named to avoid a magic `8` inside squareIndex/mirrorSquare. */
const NUM_SQUARES_PER_SIDE = 8;

/**
 * Mirrors a square vertically (rank r -> rank 9-r), keeping the file unchanged.
 * Used to translate a real-board move into the mover's-POV frame the model expects
 * when Black is to move (CONTRACT §a: "if Black to move, mirror the FEN first").
 */
function mirrorSquare(square: string): string {
  const file = square[0];
  const rank = NUM_SQUARES_PER_SIDE + 1 - Number(square[1]);
  return `${file}${rank}`;
}

/**
 * Mirrors a FEN piece-placement field: flips ranks top-to-bottom and swaps piece
 * colors (uppercase<->lowercase), so the side to move is always presented as "White"
 * moving up the board (CONTRACT §a, confirmed via the CSSLab reference client's
 * `preprocessMaia3` behavior — architecture only, no source copied).
 */
function mirrorPiecePlacement(piecePlacement: string): string {
  const ranks = piecePlacement.split('/');
  return [...ranks]
    .reverse()
    .map((row) => row.replace(/[a-zA-Z]/g, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())))
    .join('/');
}

// ─── Board -> tensor encoding (CONTRACT §a) ─────────────────────────────────────

/**
 * Encodes a single piece-placement field into the flat (64 * 12) token tensor,
 * square-major: `tokens[squareIndex(sq) * 12 + planeIdx]`.
 */
function encodePiecePlacement(piecePlacement: string): Float32Array {
  const tokens = new Float32Array(NUM_SQUARES * PLANES_PER_SQUARE);
  const rows = piecePlacement.split('/'); // rows[0] = rank8 ... rows[7] = rank1
  for (let rowFromTop = 0; rowFromTop < NUM_SQUARES_PER_SIDE; rowFromTop++) {
    const row = NUM_SQUARES_PER_SIDE - 1 - rowFromTop; // rank8 -> row7, rank1 -> row0
    let file = 0;
    const rowStr = rows[rowFromTop] ?? '';
    for (const char of rowStr) {
      const emptyCount = Number.parseInt(char, 10);
      if (Number.isNaN(emptyCount)) {
        const planeIdx = PIECE_PLANE_ORDER.indexOf(char as (typeof PIECE_PLANE_ORDER)[number]);
        if (planeIdx >= 0) {
          tokens[(row * NUM_SQUARES_PER_SIDE + file) * PLANES_PER_SQUARE + planeIdx] = 1.0;
        }
        file += 1;
      } else {
        file += emptyCount;
      }
    }
  }
  return tokens;
}

/**
 * Encodes a FEN into the Maia-3 `tokens[64,12]` input tensor (flat, no batch dim —
 * caller/worker stacks per-ELO copies into the batch). Mirrors the board to the
 * mover's POV when Black is to move (CONTRACT §a). `historyFens` is accepted for
 * API-forward-compatibility but ignored: the confirmed contract is n=0 history
 * ("simplified" export carries no history planes — CONTRACT §a).
 */
export function encodeBoard(fen: string, historyFens?: string[]): Float32Array {
  // Accepted for API-forward-compatibility with a future non-simplified export;
  // intentionally unused under the confirmed n=0 contract (see doc comment above).
  void historyFens;
  const [piecePlacement, activeColor] = fen.split(' ');
  if (piecePlacement === undefined) {
    throw new Error(`maiaEncoding: invalid FEN (no piece-placement field): ${fen}`);
  }
  const isBlackToMove = activeColor === 'b';
  const framed = isBlackToMove ? mirrorPiecePlacement(piecePlacement) : piecePlacement;
  return encodePiecePlacement(framed);
}

// ─── ELO input (CONTRACT §b) ────────────────────────────────────────────────────

/**
 * Maps a ladder ELO value to the CONTRACT's confirmed ELO input form: a raw
 * continuous float scalar fed directly as `elo_self`/`elo_oppo` (CONTRACT §b —
 * Assumption A1 CONFIRMED, no caller-side embedding). Kept as a named function
 * (rather than passing `elo` straight through at call sites) so the single
 * confirmed mechanism has one place to change if the model's ELO input contract
 * is ever revised.
 */
export function eloToInput(elo: number): number {
  return elo;
}

// ─── Policy vocabulary index (CONTRACT §d) ──────────────────────────────────────

/**
 * Computes the flat policy-vocab index for a move, keyed by `from + to + promotion`
 * (CONTRACT §d). Queen promotions (the default) share the base from*64+to lane with
 * non-promoting moves — a pawn reaching the back rank always promotes, so `to` alone
 * disambiguates it. Underpromotions (r/b/n) use a reserved lane keyed by destination
 * + piece only (origin is unambiguous from board state). See UNDERPROMOTION_PIECE_LANES
 * doc comment for the vocab-size derivation and the open cross-validation risk.
 */
function moveVocabIndex(from: string, to: string, promotion?: string): number {
  const fromIdx = squareIndex(from);
  const toIdx = squareIndex(to);
  if (promotion === undefined || promotion === 'q') {
    return fromIdx * NUM_SQUARES + toIdx;
  }
  const laneIdx = UNDERPROMOTION_PIECE_LANES.indexOf(promotion as PromotionPiece);
  return BASE_VOCAB_SIZE + toIdx * UNDERPROMOTION_PIECE_LANES.length + laneIdx;
}

// ─── Legal-move masking + softmax (MAIA-03) ─────────────────────────────────────

/**
 * Masks the model's flat policy logits to the current FEN's legal moves (via
 * chess.js) and applies a numerically-stable softmax, returning a normalized
 * per-legal-move probability distribution keyed by SAN. Illegal moves are never
 * present in the output (only chess.js-enumerated legal moves are read from the
 * policy tensor). Mirrors from/to squares into the model's frame when Black is to
 * move (CONTRACT §d "mirror caveat") before indexing into `policy`.
 */
export function maskAndSoftmax(policy: Float32Array, fen: string): Record<string, number> {
  const chess = new Chess(fen);
  const isBlackToMove = fen.split(' ')[1] === 'b';
  const legalMoves = chess.moves({ verbose: true });

  const scores = legalMoves.map((move) => {
    const from = isBlackToMove ? mirrorSquare(move.from) : move.from;
    const to = isBlackToMove ? mirrorSquare(move.to) : move.to;
    const idx = moveVocabIndex(from, to, move.promotion);
    return policy[idx] ?? Number.NEGATIVE_INFINITY;
  });

  const max = scores.length > 0 ? Math.max(...scores) : 0;
  const exps = scores.map((s) => Math.exp(s - max));
  const sum = exps.reduce((a, b) => a + b, 0);

  const probabilities: Record<string, number> = {};
  legalMoves.forEach((move, i) => {
    probabilities[move.san] = sum > 0 ? (exps[i] ?? 0) / sum : 0;
  });
  return probabilities;
}

// ─── Single-pass UCI-keyed policy conversion (JANK-01) ──────────────────────────

/**
 * Shape of the move objects chess.js's private `_moves({legal:true})` returns
 * (reconstructed from `addMove()`, `chess.js:1754-1778` — NOT exported by
 * chess.js's `.d.ts`, which declares `_moves` as an untyped private member).
 * `from`/`to` are 0x88-style numeric square indices, not algebraic strings.
 */
interface InternalMove {
  from: number;
  to: number;
  promotion?: PromotionPiece;
}

/**
 * Converts a chess.js 0x88-style numeric square index to its algebraic
 * string, matching chess.js's own private `algebraic()` helper exactly
 * (`chess.js:1591-1596`: file = square & 0xf, rank = square >> 4).
 */
function algebraicFromIndex(square: number): string {
  const file = square & 0xf;
  const rank = square >> 4;
  return `${'abcdefgh'[file]}${'87654321'[rank]}`;
}

/**
 * Single-pass UCI-keyed counterpart to `maskAndSoftmax` above (JANK-01).
 * Reads chess.js's private `_moves({legal:true})` ONCE and builds UCI keys
 * directly from each internal move's numeric `from`/`to`/`promotion` fields —
 * never constructing a `Move` object (whose constructor re-runs full
 * legal-move generation a second time to produce SAN, `chess.js:1328`) or a
 * per-candidate `Chess` instance. `maskAndSoftmax` stays SAN-keyed and
 * unchanged for `useMaiaEngine.ts`'s Moves-by-Rating chart; this function
 * exists because `maiaQueue.ts`'s hot path only ever needs UCI keys, and the
 * previous per-SAN `sanToUci` replay (`sanToSquares.ts`) was the real O(n²)
 * main-thread cost (JANK-01/194-RESEARCH.md Pattern 1). A `chess.js` version
 * bump that changes `_moves`'s internal move-object shape or the
 * promotion-lane enumeration order is guarded by the parity test in
 * `maiaEncoding.test.ts`'s `describe('maskAndSoftmaxUci', ...)` block, which
 * pins this function's output key-for-key and value-for-value against
 * `maskAndSoftmax` + `sanToUci` (JANK-02).
 */
export function maskAndSoftmaxUci(policy: Float32Array, fen: string): Record<string, number> {
  const chess = new Chess(fen);
  const isBlackToMove = fen.split(' ')[1] === 'b';
  // Bracket-notation bypasses the `private _moves` TS declaration — same idiom
  // chess.js's own Move constructor uses internally (chess.js:1328).
  const internalMoves = chess['_moves']({ legal: true }) as InternalMove[];

  const ucis: string[] = [];
  const scores: number[] = [];
  for (const move of internalMoves) {
    const from = algebraicFromIndex(move.from);
    const to = algebraicFromIndex(move.to);
    const idx = moveVocabIndex(
      isBlackToMove ? mirrorSquare(from) : from,
      isBlackToMove ? mirrorSquare(to) : to,
      move.promotion,
    );
    ucis.push(`${from}${to}${move.promotion ?? ''}`);
    scores.push(policy[idx] ?? Number.NEGATIVE_INFINITY);
  }

  const max = scores.length > 0 ? Math.max(...scores) : 0;
  const exps = scores.map((s) => Math.exp(s - max));
  const sum = exps.reduce((a, b) => a + b, 0);

  const probabilities: Record<string, number> = {};
  ucis.forEach((uci, i) => {
    probabilities[uci] = sum > 0 ? (exps[i] ?? 0) / sum : 0;
  });
  return probabilities;
}

// ─── Expected score (CONTRACT §e, D-04) ─────────────────────────────────────────

/** Weight applied to a draw when collapsing WDL to a single expected-score fill (D-04). */
const DRAW_WEIGHT = 0.5;

/**
 * Collapses a WDL probability vector into a single expected-score fraction
 * (0..1), used by the Maia eval bar (D-04: single expected-score fill, not a
 * 3-segment W/D/L stack).
 */
export function expectedScore(wdl: WdlVector): number {
  return wdl.win + DRAW_WEIGHT * wdl.draw;
}

/**
 * Softmaxes the raw `logits_value` output into a normalized WDL probability
 * vector. Confirmed logit order (CONTRACT §e): index 0 = Loss, 1 = Draw, 2 = Win
 * — NOT W/D/L. Numerically stable (subtracts the max before exponentiating), same
 * technique as `maskAndSoftmax`. Used by `useMaiaEngine` (Task 3) to turn the
 * worker's raw per-ELO WDL logits into the vector `expectedScore` consumes.
 */
export function softmaxWdl(logits: ArrayLike<number>): WdlVector {
  const values: number[] = [];
  for (let i = 0; i < logits.length; i++) {
    values.push(logits[i] ?? 0);
  }
  const max = values.length > 0 ? Math.max(...values) : 0;
  const exps = values.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  const probabilityAt = (idx: number): number => {
    const e = exps[idx] ?? 0;
    return sum > 0 ? e / sum : 0;
  };
  return { loss: probabilityAt(0), draw: probabilityAt(1), win: probabilityAt(2) };
}
