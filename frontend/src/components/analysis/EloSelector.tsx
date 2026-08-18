/**
 * EloSelector — interactive control driving the "you are here" ELO used by the
 * FlawChess and Maia engines (Phase 151 Plan 05, D-06; moved between the FlawChess
 * and Maia cards in 164 UAT since it drives both). A single-thumb Slider snapped to
 * the Maia ELO ladder (MAIA_ELO_LADDER, 600-2600 step 100 per UAT quick 260705-bm3) —
 * bounds and step derive from the ladder, never hard-coded, so a future contract
 * revision (a wider/narrower ladder) doesn't require touching this component.
 */

import { RotateCcw } from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import { InfoPopover } from '@/components/ui/info-popover';
import { MAIA_ELO_LADDER } from '@/lib/maiaEncoding';

/** ChessGoals rating-comparison study backing the Lichess-Blitz normalization (Phase 164). */
const CHESSGOALS_RATING_URL = 'https://chessgoals.com/rating-comparison/';

export interface EloSelectorProps {
  /** Current selected ELO — must be a value present in `ladder`. */
  value: number;
  /** Called with the new ladder ELO when the user moves the slider. */
  onChange: (elo: number) => void;
  /**
   * The players' derived default ELO. When provided and different from `value`,
   * an inline reset control appears to snap back to it (164 UAT). Omit to hide it.
   */
  defaultElo?: number;
  /** Resets the slider to `defaultElo`. Required for the reset control to render. */
  onReset?: () => void;
  /** Ladder rungs the slider snaps to. Defaults to MAIA_ELO_LADDER. */
  ladder?: readonly number[];
}

/** Fallback step (ELO) used only if `ladder` somehow has a single rung. */
const SINGLE_RUNG_STEP_FALLBACK = 100;

/** Explains what the ELO drives and why it's shown on a Lichess-Blitz-normalized scale. */
function EloInfoTooltip(): React.ReactElement {
  return (
    <InfoPopover ariaLabel="About the ELO setting" testId="analysis-elo-info-popover">
      <div className="max-w-xs space-y-2">
        <p>
          The FlawChess engine selects Maia moves at this rating. It defaults to the player's rating, converted to
          a Lichess Blitz equivalent — the scale the human model is trained on — so strength
          is comparable across platforms and time controls.
        </p>
        <p>
          Conversion uses the{' '}
          <a
            href={CHESSGOALS_RATING_URL}
            data-umami-event="outbound-chessgoals"
            target="_blank"
            rel="noopener noreferrer"
            data-testid="analysis-elo-info-link-chessgoals"
            className="underline"
          >
            chessgoals.com
          </a>{' '}
          rating comparison tables. Drag the slider to explore other levels.
        </p>
      </div>
    </InfoPopover>
  );
}

export function EloSelector({
  value,
  onChange,
  defaultElo,
  onReset,
  ladder = MAIA_ELO_LADDER,
}: EloSelectorProps): React.ReactElement {
  const min = ladder[0] ?? value;
  const max = ladder[ladder.length - 1] ?? value;
  const first = ladder[0];
  const second = ladder[1];
  const step = first !== undefined && second !== undefined ? second - first : SINGLE_RUNG_STEP_FALLBACK;

  const handleValueChange = (values: number[]): void => {
    const next = values[0];
    if (next === undefined) return;
    onChange(next);
  };

  // Reset control shows only once the user has moved off the players' default (164
  // UAT): inline in the row so it costs no vertical space, and vanishes at default.
  const canReset = onReset !== undefined && defaultElo !== undefined && value !== defaultElo;

  return (
    <div
      data-testid="analysis-elo-selector"
      role="group"
      aria-label="Engine strength (ELO)"
      className="flex items-center gap-3"
    >
      <div className="flex items-center gap-1">
        <span className="text-sm text-muted-foreground">ELO</span>
        <EloInfoTooltip />
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={handleValueChange}
        thumbLabels={['Engine strength (ELO)']}
        className="min-w-24"
      />
      <span
        className="text-sm font-medium tabular-nums w-12 text-right"
        data-testid="analysis-elo-selector-value"
      >
        {value}
      </span>
      {canReset && (
        <button
          type="button"
          onClick={onReset}
          aria-label={`Reset ELO to ${defaultElo}`}
          title={`Reset to ${defaultElo}`}
          data-testid="analysis-elo-selector-reset"
          className="shrink-0 text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
        >
          <RotateCcw className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
