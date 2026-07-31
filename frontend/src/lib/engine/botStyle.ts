/**
 * botStyle — the pure, synchronous bot-style transform module (Phase 182,
 * STYLE-01/03/04/05). Holds the `BotStyleParams` raw-numeric-knob data type
 * (D-01: engine code consumes ONLY numbers — no style names, no player
 * derivation, BOT-03), the cheap chess.js move-feature classifier, and (in
 * later plan tasks landing in this same file) the three pure transforms
 * that hook `selectBotMove`'s existing seams: prior reweighting (STYLE-03,
 * Human rungs), score shaping (STYLE-04, Light/Deep rungs), and
 * opening-book weighting (STYLE-01, composed over `openingBook.ts`'s
 * `maiaPolicyWeighting`).
 *
 * DEVIATION from `openingBook.ts`'s "no chess.js import" purity convention:
 * this module DOES import `chess.js` — `classifyMoveFeatures` needs the
 * verbose `Move` object's `.san`/`.flags`/`.piece`/`.captured`/`.from`/`.to`
 * fields (checks, captures, pawn geometry) to derive per-move style
 * features. Every function here otherwise stays synchronous, has no I/O,
 * and touches no React/provider state — the same "pure engine module"
 * contract every sibling in this directory follows.
 *
 * Every knob on `BotStyleParams` is `[ASSUMED]`/hand-tuned per D-12 —
 * magnitudes are set by Plan 05's bundles, iterated against the
 * `scripts/style-lever-measurement.mjs` measurement script, not derived
 * analytically. This module only defines the SHAPE and the pure transforms;
 * it ships no named style bundle itself (that is Plan 05's
 * `botStyleBundles.ts`).
 *
 * Forward pointers — the exact call sites that will consume these exports:
 *   - `applyStylePriorReweighting`: `selectBotMove.ts`'s `blend<=0` branch,
 *     between `deps.policy()` and `botSampling.ts`'s `samplePolicy` (Plan 06).
 *   - `applyStyleScoreShaping`: `selectBotMove.ts`'s search branch, between
 *     `search()` and `argmaxLine`/`sampleRankedLines` (Plan 06).
 *   - `styleBookWeighting`: `useBotGame.ts`'s `resolveBookMove`, passed as
 *     `openingBook.ts`'s `selectBookMove` `weighting` argument (Plan 07).
 *   - `BotStyleParams`: `BotSettings.style?` (Plan 06) and
 *     `BotGameSettings.style?` (Plan 07) — always optional; `undefined`
 *     everywhere runs today's exact code path (D-03).
 */

import { Chess, type Move } from 'chess.js';
import type { RankedLine } from './types';
import { cloneRankedLineWith } from './treeCommon';
import { maiaPolicyWeighting, type BookCandidate, type BookWeightingFn } from './openingBook';

// ─── BotStyleParams (D-01: raw numeric knobs, no function fields) ─────────

/**
 * Per-`MoveFeatures`-flag prior-reweighting multiplier (D-01/STYLE-03).
 * Keyed 1:1 with `MoveFeatures`' boolean flags. A feature that is `false`
 * for a given move contributes no multiplier (the move's raw weight is left
 * as-is for that flag); a `true` flag multiplies the raw weight by the
 * corresponding value here. `1` is the neutral/no-op multiplier for a
 * feature this style does not care about.
 */
export interface FeatureMultipliers {
  isCheck: number;
  isCapture: number;
  isPawnAdvance: number;
  isPawnStorm: number;
  isExchange: number;
  isRetreat: number;
}

/**
 * A plain data object (D-01/BOT-03 Tampering guard — deliberately NO
 * function-typed field anywhere in this interface) holding every numeric
 * knob a style needs across the three levers this phase builds. Populated
 * only from Plan 05's exported bundle constants; never derived from player
 * state (BOT-03) and never merged into `selectBotMove`'s `SearchBudget`
 * (STYLE-05 — stays a sibling of `budget`, not a member of it).
 */
export interface BotStyleParams {
  /** D-01/STYLE-03: per-move-feature Maia-prior multiplier, applied inside
   * `applyStylePriorReweighting` (Human rungs, `blend<=0`). */
  featureMultipliers: FeatureMultipliers;
  /**
   * D-01/D-12/STYLE-04: flat additive score-shaping bonus (small
   * expected-score units, e.g. +/-0.02 to 0.05 per D-12) applied to EVERY
   * `RankedLine.practicalScore` during `applyStyleScoreShaping` (Light/Deep
   * rungs). Positive = this style generally prefers being in the kind of
   * position the search already found; negative = a malus. Uniform across
   * all lines for a given call — the per-line differentiation for
   * "sharper vs quieter" comes from `varianceBonus` below, not this field.
   */
  scoreBonus: number;
  /**
   * D-01/D-10/STYLE-04: multiplier applied to `RankedLine.childScoreSpread`
   * (the variance/"sharpness" proxy) — added to `practicalScore` only when
   * `childScoreSpread` is non-null (D-10's null boundary: no spread signal,
   * no variance term). Positive = prefers wider-spread/sharper
   * continuations (e.g. Trickster); negative = prefers flat/quiet ones
   * (e.g. Wall).
   */
  varianceBonus: number;
  /**
   * D-01/D-09: signed draw-value shift, in expected-score units. The
   * draw-accept gate (`botDrawGate.ts`'s `wouldBotAcceptDraw`) treats a draw
   * as worth `0.5 - contempt`. Positive = avoids draws (wants more before
   * settling, e.g. Grinder); negative = welcomes them slightly early
   * (e.g. Wall). Consumed directly by `botDrawGate.ts`, not by any function
   * in this module.
   */
  contempt: number;
  /** D-01/D-08: the `practicalScore` floor a Light/Deep-rung bot must stay
   * at or below, on its own turns, before resignation becomes eligible.
   * Consumed by `botDrawGate.ts`'s `wouldBotResign`, not by this module. */
  threshold: number;
  /** D-01/D-08: consecutive own-turn count at/below `threshold` required
   * before the bot actually resigns (hysteresis — avoids resigning off one
   * bad grade). Consumed by `botDrawGate.ts`'s `wouldBotResign`, not by
   * this module. */
  hysteresisFloor: number;
  /** D-01/D-06: opening-book boost multiplier (~x20-50 per D-06) applied to
   * a style-line candidate's base Maia weight inside `styleBookWeighting`
   * (added to this file by this phase's Task 3). */
  bookBoost: number;
}

// ─── Move-feature classification (the one genuinely new piece of logic) ───

/** Per-move style features, cheaply derived from a chess.js verbose `Move`
 * (Phase 182, STYLE-03 — the classifier `applyStylePriorReweighting` reads). */
export interface MoveFeatures {
  /** `move.san` carries a `+` (check) or `#` (checkmate) suffix. */
  isCheck: boolean;
  /** A normal capture (`move.flags` has `c`) or an en-passant capture
   * (`move.flags` has `e`). */
  isCapture: boolean;
  /** A pawn move that is NOT a capture. */
  isPawnAdvance: boolean;
  /** A pawn move advancing into the opponent's half of the board (rank >= 5
   * for White, rank <= 4 for Black) — independent of capture status; a
   * capturing pawn push into enemy territory is both `isPawnAdvance: false`
   * (it IS a capture) and `isPawnStorm: true`. */
  isPawnStorm: boolean;
  /** A capture where the captured piece's value and the moving piece's
   * value are close (a roughly even trade), per `PIECE_VALUE` below. */
  isExchange: boolean;
  /** A non-pawn piece moving toward its own back rank (decreasing rank for
   * White, increasing rank for Black). */
  isRetreat: boolean;
}

/** Standard relative piece values used only for the `isExchange` "roughly
 * even trade" heuristic below — NOT an evaluation function, just a coarse
 * classification input. King is valueless here since it is never captured. */
export const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** The max value gap (in `PIECE_VALUE` units) between the captured piece and
 * the capturing piece for a capture to still count as `isExchange` (a
 * "roughly even trade") rather than a material-winning/losing capture.
 * [ASSUMED] hand-tuned per D-12; a pawn-for-pawn or minor-for-minor trade
 * both clear this (gap 0), a minor-for-rook or minor-for-queen does not. */
export const EXCHANGE_VALUE_GAP = 1;

/** The board rank (1-8) at/beyond which a pawn advance counts as having
 * crossed into the opponent's half — White storms at rank >= 5, Black
 * storms at rank <= (9 - 5) = 4 (the board-rank mirror). [ASSUMED] per
 * D-12; the halfway point of an 8-rank board. */
const WHITE_STORM_MIN_RANK = 5;
const BLACK_STORM_MAX_RANK = 4;

/**
 * Classifies a single legal chess.js verbose `Move` into `MoveFeatures`
 * (Phase 182, STYLE-03). White/Black geometry is mirrored correctly for the
 * two color-dependent flags (`isPawnStorm`, `isRetreat`) — "forward" for a
 * pawn storm and "backward" for a retreat both depend on which way the
 * mover's own back rank sits. Pure, synchronous, no board re-derivation
 * beyond the fields chess.js's own `.moves({ verbose: true })` already
 * computes.
 */
export function classifyMoveFeatures(move: Move): MoveFeatures {
  const isCapture = move.flags.includes('c') || move.flags.includes('e');
  const isCheck = move.san.includes('+') || move.san.includes('#');
  const isPawnAdvance = move.piece === 'p' && !isCapture;

  const fromRank = Number(move.from[1]);
  const toRank = Number(move.to[1]);
  const isPawnStorm =
    move.piece === 'p' &&
    (move.color === 'w' ? toRank >= WHITE_STORM_MIN_RANK : toRank <= BLACK_STORM_MAX_RANK);

  const capturedValue = move.captured ? (PIECE_VALUE[move.captured] ?? 0) : 0;
  const moverValue = PIECE_VALUE[move.piece] ?? 0;
  const isExchange = isCapture && Math.abs(capturedValue - moverValue) <= EXCHANGE_VALUE_GAP;

  const isRetreat =
    move.piece !== 'p' && (move.color === 'w' ? toRank < fromRank : toRank > fromRank);

  return { isCheck, isCapture, isPawnAdvance, isPawnStorm, isExchange, isRetreat };
}

// ─── STYLE-03: prior reweighting (Human rungs, blend<=0) ──────────────────

/** Product of every `true` `MoveFeatures` flag's corresponding
 * `FeatureMultipliers` value; a move matching no features returns `1`
 * (neutral — the raw weight is left unchanged). */
function featureMultiplierProduct(
  features: MoveFeatures,
  multipliers: FeatureMultipliers,
): number {
  let product = 1;
  if (features.isCheck) product *= multipliers.isCheck;
  if (features.isCapture) product *= multipliers.isCapture;
  if (features.isPawnAdvance) product *= multipliers.isPawnAdvance;
  if (features.isPawnStorm) product *= multipliers.isPawnStorm;
  if (features.isExchange) product *= multipliers.isExchange;
  if (features.isRetreat) product *= multipliers.isRetreat;
  return product;
}

/**
 * Multiplies each raw Maia policy weight by its move's style feature
 * multiplier product (D-01/STYLE-03). Returns an UNNORMALIZED
 * `Record<string, number>` — `botSampling.ts`'s `samplePolicy` (via its
 * internal `weightedPick`) already walks unnormalized weights correctly
 * (see `openingBook.ts`'s `maiaPolicyWeighting` doc comment for the same
 * "no renormalization math" reasoning); do NOT add a normalization step
 * here.
 *
 * Re-derives `fen`'s legal moves via chess.js to resolve each `rawPolicy`
 * UCI key back to its verbose `Move` for classification — mirrors
 * `botSampling.ts`'s `fallbackMove` convention of never trusting a stale
 * candidate set. A `rawPolicy` key with no matching legal move (should not
 * happen for a well-formed policy, but defensively handled) keeps its raw
 * weight unchanged (multiplier `1`), same as a move matching zero features.
 */
export function applyStylePriorReweighting(
  rawPolicy: Record<string, number>,
  fen: string,
  style: BotStyleParams,
): Record<string, number> {
  const chess = new Chess(fen);
  const movesByUci = new Map<string, Move>();
  for (const move of chess.moves({ verbose: true })) movesByUci.set(move.lan, move);

  const reweighted: Record<string, number> = {};
  for (const [uci, weight] of Object.entries(rawPolicy)) {
    const move = movesByUci.get(uci);
    const multiplier = move
      ? featureMultiplierProduct(classifyMoveFeatures(move), style.featureMultipliers)
      : 1;
    reweighted[uci] = weight * multiplier;
  }
  return reweighted;
}

// ─── STYLE-04: score shaping (Light/Deep rungs, search branch) ────────────

/** Clamps `value` into `[0, 1]`. `NaN` propagates through unchanged (both
 * `Math.max`/`Math.min` comparisons against `NaN` are false), matching the
 * "a non-finite shaped score falls through to `weightedPick`'s
 * `Number.isFinite` guard" contract (STYLE-04 precision edge) — this
 * function does not itself special-case non-finite input beyond what the
 * clamp naturally does (an infinite bonus clamps to a finite bound; a NaN
 * bonus stays NaN for the downstream guard to catch). */
function clampUnitInterval(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Returns a new `RankedLine[]` with each line's `practicalScore` additively
 * adjusted by `style.scoreBonus` plus a variance term
 * (`style.varianceBonus * line.childScoreSpread`) — the variance term is
 * applied ONLY when `childScoreSpread` is non-null (D-10's null boundary:
 * no spread signal, no variance term, per STYLE-04's must-have). The result
 * is clamped into `[0, 1]`. Every other `RankedLine` field
 * (`rootMove`/`objectiveEvalCp`/`objectiveEvalMate`/`modalPath`/
 * `modalStats`/`visits`/`childScoreSpread`) is copied unchanged — this
 * transform is additive-only on `practicalScore` alone, so
 * `argmaxLine`/`sampleRankedLines` (`botSampling.ts`) read the shaped score
 * off the exact same `RankedLine` shape they already consume.
 *
 * Phase 194 JANK-03 fix: this function is called from `selectBotMove.ts` for
 * EVERY persona bot move (every rung carries a `style`) — exactly the case
 * lazy `modalPath`/`modalStats` accessors exist to make free. The previous
 * implementation did `{ ...line, practicalScore: ... }`: an object spread
 * reads every own enumerable property, accessor or not, and bakes the
 * getter's CURRENT value into a plain data property on the new object —
 * silently forcing eager evaluation of `modalPath`/`modalStats` for every
 * one of the (up to `ROOT_CANDIDATE_HARD_CAP`) root candidates, on every bot
 * move, defeating JANK-03 for the exact "bot play: 100% waste" case the
 * optimization targets. `Object.getOwnPropertyDescriptors` copies the
 * DESCRIPTOR (getter identity + laziness), not the current value, so the
 * shaped line's `modalPath`/`modalStats` stay unevaluated accessors.
 */
export function applyStyleScoreShaping(
  lines: readonly RankedLine[],
  style: BotStyleParams,
): RankedLine[] {
  return lines.map((line) => {
    const varianceTerm =
      line.childScoreSpread !== null ? style.varianceBonus * line.childScoreSpread : 0;
    const shaped = clampUnitInterval(line.practicalScore + style.scoreBonus + varianceTerm);
    return cloneRankedLineWith(line, { practicalScore: shaped });
  });
}

// ─── STYLE-01: opening-book weighting (composes over maiaPolicyWeighting) ─

/**
 * Factory returning a `BookWeightingFn` that composes `openingBook.ts`'s
 * `maiaPolicyWeighting` (D-06: a style re-weights what is on the menu, it
 * never replaces the base restriction-to-candidates logic — reused here,
 * never reimplemented). Each candidate whose FULL joined move-history
 * prefix (`[...moveHistorySan, candidate.san].join(' ')`) is a member of
 * `styleLinePrefixes` gets its base Maia weight multiplied by
 * `boostMultiplier`; every other candidate keeps its base weight unchanged.
 *
 * `moveHistorySan` is curried in at construction time (Pitfall 2,
 * 182-RESEARCH.md): `BookWeightingFn`'s own signature only receives
 * `candidates`/`rawPolicy` for the CURRENT ply, never the history, and this
 * factory deliberately does NOT change that signature — `maiaPolicyWeighting`'s
 * existing 2-arg shape must keep compiling unchanged. A naive
 * `styleLinePrefixes.has(candidate.san)` check (bare SAN, no history) would
 * only work for a line's first move; every subsequent ply needs the full
 * joined prefix to disambiguate between lines that share an opening move.
 *
 * `selectBookMove`'s RAW-policy floor check (`BOOK_POLICY_FLOOR`) runs
 * BEFORE this — or any — `weighting` function is ever invoked (Pitfall 1;
 * see `openingBook.ts`'s own "order of operations is load-bearing"
 * comment). This factory has no visibility into that check and cannot
 * affect it: a boosted-but-implausible style line still leaves book exactly
 * as an unboosted one would.
 *
 * An empty `styleLinePrefixes` set makes every candidate fail the
 * membership test, so the returned function behaves identically to
 * `maiaPolicyWeighting` for the same `candidates`/`rawPolicy` (STYLE-01
 * empty-set edge).
 */
export function styleBookWeighting(
  styleLinePrefixes: ReadonlySet<string>,
  moveHistorySan: readonly string[],
  boostMultiplier: number,
): BookWeightingFn {
  return (candidates: readonly BookCandidate[], rawPolicy: Record<string, number>) => {
    const base = maiaPolicyWeighting(candidates, rawPolicy);
    const boosted: Record<string, number> = {};
    for (const { uci, san } of candidates) {
      const baseWeight = base[uci];
      if (baseWeight === undefined) continue;
      const key = [...moveHistorySan, san].join(' ');
      boosted[uci] = styleLinePrefixes.has(key) ? baseWeight * boostMultiplier : baseWeight;
    }
    return boosted;
  };
}
