/**
 * TrainLineStepper — a small, single-chain SAN move stepper for the Train
 * reveal's engine-line boxes (Your move / Best move / Played in game). No
 * branching, no forking, no deletion. (The opt-in tactic-line steppers it
 * also served were removed per 190.1 UAT round 4 — confusing, not needed.)
 *
 * This is the settled answer to the ROADMAP's plan-time "embed the analysis
 * page's branching-tree editor vs. build a lightweight stepper" question:
 * that existing component (1097 LOC) is a node-map graph with sibling-block
 * forking, line deletion, and click-to-fetch chip handlers — all coupled to
 * the analysis page's branching-tree editor state. None of that is needed
 * for a single linear line, so this is a fresh, small, purpose-built
 * component instead (190-05-PLAN.md Task 1 reversibility rating: swapping it
 * later touches only its two call sites). It deliberately does not import or
 * embed that component.
 *
 * The reveal's own board is the stage (D-08/D-09 — one interactive board
 * throughout): this component never mounts its own ChessBoard. It replays
 * `moves` (SAN) from `startFen` with chess.js — mirroring the exact idiom
 * `useAnalysisBoard.ts`'s `insertPvLine` already uses (`new Chess(startFen)`,
 * then `chess.move(san)` per step, breaking rather than throwing on an
 * illegal SAN) — and reports the derived FEN at the current index via
 * `onFenChange`, which the reveal wires to the shared board's position state.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Chess } from 'chess.js';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MoveQualityIcon } from '@/components/icons/MoveQualityIcon';
import { cn } from '@/lib/utils';
import { playSound } from '@/lib/sounds';
import type { SoundEvent } from '@/lib/sounds';
import { BEST_MOVE_ARROW, TRAIN_VERDICT_CORRECT, TRAIN_VERDICT_INCORRECT } from '@/lib/theme';
import type { TrainMoveQuality } from '@/lib/trainArrows';

/**
 * Height cap (T-190-19, DoS mitigation): a mate-in-many line's token list
 * scrolls within this fixed block instead of growing the reveal card
 * unboundedly. The board and prev/next controls stay fixed; only the token
 * row scrolls internally. Desktop (lg+) only — on mobile the token row is a
 * single horizontally scrolling line (190.1 UAT round 5) whose natural
 * height is far below this cap anyway.
 */
export const TRAIN_LINE_STEPPER_MAX_HEIGHT_PX = 160;

/**
 * One step-position report (190.1 UAT): everything the board owner needs to
 * render the stepped position — the FEN itself, the 0-based stepper index
 * (0 = the line's start position, before any move), the UCI of the move that
 * LED to this position (null at index 0), and the UCI of the line's NEXT move
 * from this position (null at the end of the line).
 */
export interface TrainLineStep {
  fen: string;
  index: number;
  lastMoveUci: string | null;
  nextMoveUci: string | null;
}

export interface TrainLineStepperProps {
  /**
   * SAN move tokens — one token is one ply. Required (non-optional): an
   * absent line is a compile-time error at the call site, never an empty
   * runtime render. The caller decides whether to mount this component at
   * all (never render it with an empty array).
   */
  moves: string[];
  /** FEN of the position BEFORE the first move in `moves`. */
  startFen: string;
  /**
   * Heading text (190.1-01, D-03) — e.g. a reveal line's role label
   * ("Played in game").
   */
  title?: string | null;
  /** Eval label rendered as a right-floated blue badge (190.1 UAT round 3 —
   * same solid-blue/white-ink treatment as the analysis board's PV badge) —
   * pass the caller's own `formatScore(evalCp, evalMate)` output; this
   * component does no eval formatting itself. Rendered only when `title` is
   * also non-null, mirroring `depthLabel`'s dependency on `motifLabel`. */
  evalLabel?: string | null;
  /** Move quality of the line's FIRST move (190.1 UAT) — renders the matching
   * quality icon (star for best, etc.) floated right next to the eval badge.
   * Omitted/null while the quality isn't known yet. Rendered only when
   * `title` is also non-null, like `evalLabel`. */
  quality?: TrainMoveQuality | null;
  /** Correctness mark rendered right after `title` (190.1 UAT round 3) — a
   * green check / red cross for the Your-move box's verdict. Omitted/null for
   * every box that carries no verdict (best/game-only boxes, tactic lines). */
  mark?: 'correct' | 'incorrect' | null;
  /** Bump to force the stepper back to index 0 (190.1 UAT "Solution" button)
   * without changing the line content. */
  resetNonce?: number;
  /**
   * Called with the FEN at the current step whenever it changes — including
   * once on mount for the initial index (index 0 = `startFen`, unless this
   * is a one-move line; see the single-move note below). The reveal wires
   * this straight to the shared board's position state (D-08/D-09: never a
   * second board).
   */
  onFenChange?: (fen: string) => void;
  /**
   * Richer sibling of `onFenChange` (190.1 UAT) — fires at the same moments
   * with the full step report (index, last-move UCI, next-move UCI) so the
   * board owner can clear the reveal overlay while stepping, highlight the
   * move that led to the shown position, and draw the next-move arrow.
   */
  onStepChange?: (step: TrainLineStep) => void;
  /** Board id passed through only if this component were ever to mount its
   * own board (it does not, by design — kept for API-shape parity/future
   * reversibility, per the plan's `<files_to_read>` guidance on distinct
   * square-testid ids when two boards coexist). Unused today. */
  boardId?: string;
}

/**
 * Replay `moves` (SAN) from `startFen`, returning the FEN AFTER each ply plus
 * each ply's UCI (for the step reports) and sound event (190.1 UAT round 4 —
 * check > capture > move, the same precedence useBotGame plays). `fens[0]` is
 * always `startFen` itself (before any move) — array indexing, never a
 * character offset into the SAN string; `ucis[i]`/`sounds[i]` describe the
 * move that takes `fens[i]` to `fens[i+1]`.
 * chess.js's `move()` THROWS (rather than returning null/undefined) on an
 * illegal or malformed SAN token, so this catches that per-token and stops
 * the replay there instead of crashing the component — mirroring
 * `insertPvLine`'s break-not-crash convention (both guard against a
 * partially/incorrectly stored PV).
 */
function replayLine(
  moves: string[],
  startFen: string,
): { fens: string[]; ucis: string[]; sounds: SoundEvent[] } {
  const chess = new Chess(startFen);
  const fens = [startFen];
  const ucis: string[] = [];
  const sounds: SoundEvent[] = [];
  for (const san of moves) {
    let move;
    try {
      move = chess.move(san);
    } catch {
      break;
    }
    fens.push(chess.fen());
    ucis.push(`${move.from}${move.to}${move.promotion ?? ''}`);
    sounds.push(chess.inCheck() ? 'check' : move.captured ? 'capture' : 'move');
  }
  return { fens, ucis, sounds };
}

export function TrainLineStepper({
  moves,
  startFen,
  title = null,
  evalLabel = null,
  quality = null,
  mark = null,
  resetNonce = 0,
  onFenChange,
  onStepChange,
}: TrainLineStepperProps): ReactElement {
  // Bug fix (190.1 UAT): callers build `moves` inline per render (e.g.
  // TrainReveal's `replayPvLine(...).map(...)`), so the array's IDENTITY
  // changes on every parent re-render even when its content doesn't. Keying
  // the replay memo and the reset-to-start effect on that identity meant the
  // parent re-render caused by this component's OWN onFenChange (stepping the
  // shared board updates the parent's fen state) immediately reset `index` to
  // 0 and snapped the board back to the puzzle position — clicking any move
  // token appeared to do nothing. Key on CONTENT instead (SAN tokens never
  // contain spaces, so a joined string is a faithful identity).
  const movesKey = moves.join(' ');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- movesKey is the full content of `moves`; depending on the array identity is exactly the bug described above.
  const line = useMemo(() => replayLine(moves, startFen), [movesKey, startFen]);
  const { fens, ucis, sounds } = line;
  const lastIndex = fens.length - 1;
  const [index, setIndex] = useState(0);

  // Reset to the start whenever a new line is handed in (a different puzzle,
  // or switching between the missed/allowed tactic orientation), or when the
  // caller bumps `resetNonce` (the reveal's "Solution" button).
  useEffect(() => {
    setIndex(0);
  }, [movesKey, startFen, resetNonce]);

  useEffect(() => {
    const fen = fens[index] ?? startFen;
    onFenChange?.(fen);
    onStepChange?.({
      fen,
      index,
      lastMoveUci: index > 0 ? (ucis[index - 1] ?? null) : null,
      nextMoveUci: ucis[index] ?? null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onFenChange/onStepChange are caller-provided callbacks (not expected to be re-created reactively per render); reacting only to index/line avoids a possible infinite loop if the caller passes an inline arrow.
  }, [index, line]);

  // A one-move line has nothing to step through — there is exactly one
  // meaningful frame (the move itself), so both controls are hard-disabled
  // regardless of the general index math below (which would otherwise leave
  // "next" enabled at the initial index=0/startFen state for any line with
  // >=1 move). This is a deliberate special case, not an off-by-one bug —
  // see the plan's must_haves: "A one-move line renders the stepper with
  // both prev and next controls disabled."
  const isSingleMove = moves.length === 1;
  const canGoBack = !isSingleMove && index > 0;
  const canGoForward = !isSingleMove && index < lastIndex;

  // 190.1 UAT round 5: on mobile the token row is a single horizontally
  // scrolling line, so stepping past the visible ~5 plies must bring the
  // current token into view (also keeps a long wrapped line's vertical
  // scroll honest on desktop). scrollIntoView is optional-called — jsdom
  // doesn't implement it.
  const tokensRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = tokensRef.current;
    if (container === null) return;
    if (index === 0) {
      container.scrollLeft = 0;
      container.scrollTop = 0;
      return;
    }
    const active = container.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [index]);

  /**
   * Step to `nextIndex`, playing the matching move sound first (190.1 UAT
   * round 4). Fired from the click handlers directly (a user gesture, so
   * autoplay policies never block it — no unlockAudio dance needed): a
   * forward step/jump plays the arrived-at move's own sound (check >
   * capture > move), a backward step plays the plain move sound. playSound
   * itself no-ops when the shared mute preference (same toggle as bot
   * games) is on.
   */
  function goTo(nextIndex: number): void {
    if (nextIndex === index) return;
    const soundEvent = nextIndex > index ? sounds[nextIndex - 1] : 'move';
    if (soundEvent !== undefined) playSound(soundEvent);
    setIndex(nextIndex);
  }

  return (
    <div className="flex flex-col gap-2" data-testid="train-line-stepper">
      {title != null && (
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-xl font-semibold" data-testid="train-line-stepper-title">
            {title}
            {mark != null && (
              <span
                className="ml-1"
                data-testid="train-line-stepper-mark"
                style={{ color: mark === 'correct' ? TRAIN_VERDICT_CORRECT : TRAIN_VERDICT_INCORRECT }}
              >
                {mark === 'correct' ? '✓' : '✗'}
              </span>
            )}
          </p>
          <span className="flex shrink-0 items-center gap-1.5">
            {quality != null && (
              <span data-testid="train-line-stepper-quality" data-quality={quality}>
                <MoveQualityIcon quality={quality} className="h-4 w-4" />
              </span>
            )}
            {evalLabel != null && (
              <span
                className="rounded px-1.5 py-0.5 text-sm font-semibold text-white"
                style={{ backgroundColor: BEST_MOVE_ARROW }}
                data-testid="train-line-stepper-eval"
              >
                {evalLabel}
              </span>
            )}
          </span>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Previous move"
          data-testid="btn-train-step-prev"
          disabled={!canGoBack}
          onClick={() => goTo(Math.max(0, index - 1))}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        {/* 190.1 UAT round 5: mobile shows ONE text line (~5 plies fit) that
            scrolls horizontally; desktop (lg+) keeps the wrapping block with
            its vertical-scroll height cap. */}
        <div
          ref={tokensRef}
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto lg:flex-wrap lg:content-start lg:overflow-x-hidden lg:overflow-y-auto"
          style={{ maxHeight: TRAIN_LINE_STEPPER_MAX_HEIGHT_PX }}
          data-testid="train-line-stepper-moves"
        >
          {moves.map((san, moveIdx) => {
            // Array indexing — one token is one ply. Token at moves-array
            // index `moveIdx` is reached at stepper index `moveIdx + 1`
            // (fens[0] is startFen, before any move).
            const tokenIndex = moveIdx + 1;
            return (
              <button
                key={`${moveIdx}-${san}`}
                type="button"
                data-testid={`train-line-stepper-token-${moveIdx}`}
                data-active={tokenIndex === index ? 'true' : undefined}
                className={cn(
                  'shrink-0 rounded px-1.5 py-0.5 text-sm font-semibold',
                  tokenIndex === index
                    ? 'bg-brand-brown text-white'
                    : 'text-muted-foreground hover:bg-muted',
                )}
                onClick={() => goTo(tokenIndex)}
              >
                {san}
              </button>
            );
          })}
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Next move"
          data-testid="btn-train-step-next"
          disabled={!canGoForward}
          onClick={() => goTo(Math.min(lastIndex, index + 1))}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
