/**
 * types — the frozen public contract of the Phase 153 pure search core.
 *
 * These types are locked for the rest of the v2.0 FlawChess Engine milestone
 * (Phases 154-157 build against them unchanged). Every field cites the
 * decision that fixes its shape:
 *   - D-04: the root-only extra-move union with Maia top-k.
 *   - D-06: `practicalScore`/`RankedLine` are root-side-to-move expected
 *     score (0-1), never a per-node/per-ply-relative value.
 *   - D-07: ELO is color-keyed ({w, b}), never self/opponent-keyed.
 *   - D-08: the engine core speaks UCI everywhere (moves, policy keys,
 *     grade keys, paths) and side-to-move is the FEN 'w'/'b' literal.
 *   - D-09: one node = one expansion event (the unit `maxNodes` counts).
 */

import type { MoveGrade } from '@/lib/moveQuality';

// Re-exported so the engine core has a single import surface for move
// grading — do NOT redeclare a structurally-duplicate interface here.
export type { MoveGrade };

/** FEN side-to-move literal (D-08) — 'w' or 'b', never a full-word color. */
export type Side = 'w' | 'b';

/** Fabricated-in-tests-today, real-workers-in-Phase-154 provider surface. */
export interface EngineProviders {
  /** UCI-keyed Maia move-probability distribution at `elo` for `side` to move (D-08). */
  policy(fen: string, elo: number, side: Side): Promise<Record<string, number>>;
  /**
   * UCI-keyed Stockfish shallow-eval grades for the candidate UCI moves,
   * white-POV cp (D-08). `signal` (Phase 194 ABORT-01/03) is OPTIONAL so a
   * two-argument implementation/call site stays structurally assignable to
   * this interface — widening it to required would break every existing
   * fabricated-in-tests provider and the Node calibration providers outside
   * the frontend `tsc` project (ABORT-03).
   */
  grade(fen: string, candidateUcis: string[], signal?: AbortSignal): Promise<Map<string, MoveGrade>>;
}

/**
 * Bot-play early-stop knobs (Phase 168.5 D-05/D-06) — evaluated in the
 * `mctsSearch` canonical apply-order loop against `root.children`'s own
 * `.value` fields (== `RankedLine.practicalScore`), never the findability-
 * sorted `buildRankedLines` output. Optional on `SearchBudget`; `undefined`
 * skips the stop-rule check entirely (today's unchanged full-budget
 * behavior for every existing caller — the analysis board never sets this).
 */
export interface BotStopRule {
  /** D-05: clear-winner margin the top root child's `.value` must lead the runner-up by. */
  marginThreshold: number;
  /** D-05: near-tie-flatness spread ceiling across ALL current root children's `.value`s. */
  epsilonThreshold: number;
  /** D-05/D-06: consecutive post-expansion checks the argmax UCI must hold stable before either side of the rule can fire. */
  stabilityWindow: number;
  /** D-05: shared floor gating BOTH the clear-winner and near-tie-flatness checks — neither fires before this many expansions. */
  minNodes: number;
}

/** Bounds one `SearchRunner` invocation (ENGINE-06). */
export interface SearchBudget {
  /** D-09: one node = one expansion event; the unit this budget counts. */
  maxNodes: number;
  /** D-07: color-keyed ELO, never self/opponent-keyed. */
  elo: { w: number; b: number };
  /** Locked 6-10 ply band (SEED-082). */
  maxPlies: number;
  /** D-03: in-flight expansion concurrency, >=1. */
  concurrency: number;
  /** D-04: root-only UCI moves unioned with Maia top-k at the root. */
  extraRootMoves?: string[];
  /** Phase 159 D-06/D-07: reshapes the user's-side policy before truncation; omitted/1 = no-op. */
  policyTemperature?: number;
  /** Phase 168.5 D-05/D-06: optional bot-play early-stop rule; omitted/undefined = today's unchanged full-budget behavior. */
  stopRule?: BotStopRule;
}

/**
 * Per-ply display stats for one move in a line's `modalPath`, index-aligned
 * with it (`modalStats[i]` describes `modalPath[i]`). Surfaced for the
 * move-chip hover preview so each miniboard can annotate the position it
 * shows; NOT consumed by the search itself. Both fields are read straight off
 * the search-tree node the modal path walks through (Phase 160).
 */
export interface ModalPlyStat {
  /** White-POV Stockfish eval (cp) of the position AFTER this move, if graded. */
  objectiveEvalCp: number | null;
  /**
   * White-POV Stockfish mate distance of the position AFTER this move, if the
   * grade was a forced mate (e.g. -4 for "mate in 4 against the mover"). Carried
   * alongside `objectiveEvalCp` so a forced-mate leaf renders `#-4` instead of the
   * `…` placeholder a null cp would print (quick 260709). Mutually exclusive with a
   * non-null `objectiveEvalCp` — exactly one is set for a graded position.
   */
  objectiveEvalMate: number | null;
  /**
   * Raw Maia policy probability (0-1) of this move at its parent position —
   * the un-truncated, un-temperature-reshaped value, so it matches the raw
   * Maia % shown in the prose move popovers rather than the search's
   * renormalized `prior`.
   */
  maiaProb: number | null;
}

/** One ranked root candidate line in an `EngineSnapshot` (D-06/D-08). */
export interface RankedLine {
  /** The root candidate move, UCI (D-08). */
  rootMove: string;
  /** D-06: root-side-to-move expected score, 0-1 — never per-ply-relative. */
  practicalScore: number;
  /** Objective white-POV Stockfish eval (cp) at the modal leaf, if available. */
  objectiveEvalCp: number | null;
  /**
   * Objective white-POV Stockfish mate distance at the root candidate, when the
   * grade is a forced mate (e.g. -4). Set instead of `objectiveEvalCp` for a
   * mate leaf so the FlawChess card + agreement verdict can render `#-4` rather
   * than the `…` a null cp would print (quick 260709).
   */
  objectiveEvalMate: number | null;
  /**
   * The line's most-visited continuation, UCI sequence (D-08). Phase 194
   * JANK-03: constructed as a LAZY accessor property (a getter, not a data
   * property) — computed only on first read, memoized thereafter. TypeScript
   * cannot distinguish an accessor from a data property in this type
   * declaration, so this comment is the only signal a future editor gets:
   * spreading (`{ ...line }`), `structuredClone`-ing, or otherwise cloning a
   * `RankedLine` FORCES this getter to evaluate immediately, defeating the
   * laziness this field exists for. Copy property DESCRIPTORS
   * (`Object.getOwnPropertyDescriptors`), never spread, when building a
   * derived `RankedLine` — see `botStyle.ts`'s `applyStyleScoreShaping`.
   */
  modalPath: string[];
  /**
   * Per-ply display stats index-aligned with `modalPath` (Phase 160). Phase
   * 194 JANK-03: same lazy-accessor caveat as `modalPath` above — shares ONE
   * memoized computation with it, so reading both costs exactly one
   * `buildModalPath` call, not two. Never spread a `RankedLine`.
   */
  modalStats: ModalPlyStat[];
  /** Total expansion visits attributed to this root candidate. */
  visits: number;
  /**
   * Variance/"sharpness" proxy for this root candidate (Phase 182 D-10): the
   * max−min spread across the candidate's OWN children's backed-up expected
   * scores (i.e. the grandchildren of the search root) — the per-candidate
   * signal STYLE-04's variance-preference lever reads. `null` when the
   * candidate has 0 or 1 own children (no meaningful spread to report; never
   * 0-as-a-signal for that empty case). Only comparable within a single
   * `SearchBudget.concurrency` level — differing concurrency can grow
   * different subtrees under the same root candidate, so values are not
   * meant to be compared across concurrency settings.
   */
  childScoreSpread: number | null;
}

/** The output a `SearchRunner` reports — both at completion and per `onSnapshot` tick. */
export interface EngineSnapshot {
  rankedLines: RankedLine[];
  /** D-09: count of expansion events consumed so far. */
  nodesEvaluated: number;
  /** True once `SearchBudget.maxNodes`/`maxPlies` stopped the search (not an abort). */
  budgetExhausted: boolean;
  /**
   * Phase 168.5 D-05/D-06: why the search stopped, as a sibling of
   * `budgetExhausted` (never overloading that boolean, which stays
   * maxNodes/maxPlies-only). `'early-stop'` when `SearchBudget.stopRule`
   * ended the search early, `'budget'` when maxNodes/maxPlies did, `null`
   * otherwise (natural tree completion, or an abort).
   */
  stopReason: 'budget' | 'early-stop' | null;
}
